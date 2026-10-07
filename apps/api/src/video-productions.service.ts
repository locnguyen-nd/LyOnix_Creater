/**
 * VE2E-06: `POST /video-productions` accepts an Auto submit and returns `202`
 * immediately — it never calls a provider or waits on the workflow in the HTTP
 * request (§5 "API không chờ provider/render trong request HTTP"). The actual
 * source→script→voice→media→timeline→render pipeline runs entirely inside
 * `WorkflowRunnerService`, driven by a separate background worker process
 * (`workflow-worker-main.ts`), the same "enqueue in the request, execute in a worker
 * loop" shape already established by `AudioVersionsService.generate()`/`processNext()`.
 *
 * `mode:"studio"` is accepted by the request shape (the domain models both modes via
 * `WorkflowRunMode`) but rejected here with `VALIDATION_FAILED` — Studio's own
 * pause/edit/approve submit contract is VE2E-07/08 scope, not redefined in this task.
 */
import { createHash } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import type { WorkflowRun } from "@lyonix/db";
import {
  canAccessProject,
  canWriteProjectResource,
  normalizeBackgroundSegmentBounds,
  parseBackgroundSegmentsSetting,
  readBackgroundSegmentsSetting,
  resolveBackgroundSegmentRange,
  type BackgroundSegmentCountBounds,
} from "@lyonix/domain";
import type { DurationBudgetDiagnostics, QualityGateDiagnostics, ErrorCode, MediaPlanApifyUsage, MediaPlanSegmentDiagnostics, MediaPlanVisionUsage, VideoProductionListItemResponse, VideoProductionResponse, VideoProductionSubmitRequest, VideoProductionSubmitResponse, WorkflowStepEventResponse } from "@lyonix/contracts";
import { AutomationProfilesService } from "./automation-profiles.service.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { QueueStatusService } from "./queue-status.service.js";
import { SourcesService } from "./sources.service.js";
import { asAccountRef, asRenderRef, asVoiceRef } from "./workflow-runner.service.js";
import { sanitizeOrshotOptions } from "./orshot-render.js";

export type VideoProductionOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

export type AutoProfileSetupInput = {
  name: string;
  contentAccountId: string;
  voiceAccountId: string;
  voiceId: string;
  mediaAccountId: string;
  renderAccountId: string;
  templateSnapshotId: string;
  /** Orshot render account only: format/fps/size/fit-to-narration (sanitized below; ignored by Creatomate). */
  renderOptions?: unknown;
  locale?: string;
  durationSec?: number;
  sceneCount?: number;
};

export type AutoProfileSetupResponse = { projectId: string; automationProfileId: string };

const notFoundProject = { ok: false as const, code: "NOT_FOUND" as const, message: "Không tìm thấy dự án", status: 404 };
const notFoundRun = { ok: false as const, code: "NOT_FOUND" as const, message: "Không tìm thấy video production", status: 404 };
const removableStatuses = ["completed", "failed", "cancelled", "blocked_provider", "needs_input"] as const;
const retriableStatuses = ["failed", "blocked_provider", "needs_input"] as const;

const optionalInt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
};

/**
 * VE2E-40: allowed range for a user-fixed background segment count. Placeholder 1..6 (DEC #2 does
 * not fix limits); override with BACKGROUND_SEGMENTS_MIN_COUNT / BACKGROUND_SEGMENTS_MAX_COUNT.
 * A misconfigured pair falls back to the placeholder rather than accepting nonsense.
 */
export const backgroundSegmentBoundsFromEnv = (env: NodeJS.ProcessEnv = process.env): BackgroundSegmentCountBounds =>
  normalizeBackgroundSegmentBounds({ min: optionalInt(env.BACKGROUND_SEGMENTS_MIN_COUNT) ?? 1, max: optionalInt(env.BACKGROUND_SEGMENTS_MAX_COUNT) ?? 6 });

@Injectable()
export class VideoProductionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(SourcesService) private readonly sources: SourcesService,
    @Inject(AutomationProfilesService) private readonly automationProfiles: AutomationProfilesService,
    // V04-01: the shared template readiness / compatibility check (always provided by the app module; optional for narrow unit tests).
    @Optional() @Inject(CreatomateTemplatesService) private readonly templates?: CreatomateTemplatesService,
  ) {}

  /**
   * V04-01: Auto preflight - the pinned template must belong to the chosen render account and be renderable (internal engine: rollout /
   * fallback, plus a running engine at submit) BEFORE any project / source / run is created, so script, TTS and media never run for a
   * render that cannot happen. Same rule as Studio (CreatomateTemplatesService.checkRenderable).
   */
  private async renderPreflight(renderAccountId: string, templateSnapshotId: string, checkEngine: boolean): Promise<VideoProductionOutcome<null>> {
    if (!this.templates) return { ok: true, data: null };
    const check = await this.templates.checkRenderable(templateSnapshotId, renderAccountId, { checkEngine });
    return check.ok ? { ok: true, data: null } : { ok: false, code: check.code, message: check.message, status: check.status };
  }

  /**
   * VE2E-08: "one-click Auto" needs a `Project` + a fully-configured `AutomationProfileVersion`
   * before `submit()` will accept a run, but `POST /projects` is admin-only
   * (`ProjectsService.create`) - the same gap `StudioBridgeService.createBridge()` already
   * documented and worked around for the legacy job path. This does the equivalent for a
   * brand-new Auto job: a narrow, caller-owns-it project provisioning (direct Prisma write +
   * self-grant, never exposed as a general "create any project" surface) followed by a normal
   * `AutomationProfilesService.create()` call, which now passes its own `canWriteProjectResource`
   * check because the grant above just made it true for this project. Caller resolves which
   * verified provider accounts/voiceId/template snapshot to pass in - this method only wires
   * them into a profile, it does not pick them (that's the intake form's job, spec §7
   * "Auto entry"/preflight).
   */
  async setupAutoProfile(userId: string, role: "admin" | "staff", input: AutoProfileSetupInput): Promise<VideoProductionOutcome<AutoProfileSetupResponse>> {
    if (!input.name.trim() || !input.contentAccountId.trim() || !input.voiceAccountId.trim() || !input.voiceId.trim() || !input.mediaAccountId.trim() || !input.renderAccountId.trim() || !input.templateSnapshotId.trim()) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu tài khoản content/voice/media/render hoặc template đã pin cho Auto" };
    }
    const orshotOptions = sanitizeOrshotOptions(input.renderOptions);
    if (!orshotOptions.ok) return { ok: false, code: "VALIDATION_FAILED", message: orshotOptions.message };
    const preflight = await this.renderPreflight(input.renderAccountId, input.templateSnapshotId, false);
    if (!preflight.ok) return preflight;
    const project = await this.prisma.project.create({ data: { name: input.name.trim(), createdByUserId: userId } });
    await this.grants.replaceProjectGrants(project.id, [], [userId]);
    const profile = await this.automationProfiles.create(userId, role, {
      name: `${input.name.trim()} · Auto`,
      projectId: project.id,
      contentConfig: { providerAccountId: input.contentAccountId },
      voiceConfig: { providerAccountId: input.voiceAccountId, voiceId: input.voiceId },
      mediaConfig: { providerAccountId: input.mediaAccountId },
      renderConfig: { providerAccountId: input.renderAccountId, templateSnapshotId: input.templateSnapshotId, ...(Object.keys(orshotOptions.data).length > 0 ? { orshot: orshotOptions.data } : {}) },
      outputPreset: { aspectRatio: "9:16", width: 1080, height: 1920, fps: 30 },
      locale: input.locale ?? "vi",
      durationSec: input.durationSec ?? 60,
      sceneCount: input.sceneCount ?? 10,
      costCeiling: { amount: "5.00", currency: "USD" },
    });
    if (profile === "forbidden") return { ok: false, code: "FORBIDDEN", message: "Không có quyền tạo automation profile", status: 403 };
    if (profile === "invalid") return { ok: false, code: "VALIDATION_FAILED", message: "Cấu hình automation profile không hợp lệ" };
    return { ok: true, data: { projectId: project.id, automationProfileId: profile.id } };
  }

  private queueStatusService: QueueStatusService | null = null;
  /** VE2E-62: lazily built from the same Prisma client (keeps the constructor/DI shape unchanged). */
  private get queueStatus(): QueueStatusService {
    return (this.queueStatusService ??= new QueueStatusService(this.prisma));
  }

  private async assertWriteAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return false;
    const grants = await this.grants.forUser(userId, role);
    return canWriteProjectResource(role, grants, projectId);
  }

  private async assertReadAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const grants = await this.grants.forUser(userId, role);
    return canAccessProject(role, grants, projectId);
  }

  /**
   * Auto submit. Fails fast with `PROVIDER_NOT_CONFIGURED` before creating any row
   * when the automation profile is missing a content/voice(voiceId)/media/render
   * config — same "no charge on preflight failure" principle as
   * `RenderJobsService.submit()`. Idempotent by `requestFingerprint`
   * (`{projectId, automationProfileId, profileVersion, sourceVersionId}`) — note this
   * only dedupes when the caller passes an existing `sourceId`; each inline `source`
   * creates a brand-new `SourceVersion` (and therefore a brand-new fingerprint) since
   * source creation itself is not idempotent — a retry-safe caller should create the
   * source once via `POST /projects/:id/sources` and resubmit with `sourceId`.
   */
  async submit(userId: string, role: "admin" | "staff", input: VideoProductionSubmitRequest): Promise<VideoProductionOutcome<VideoProductionSubmitResponse>> {
    if (input.mode !== "auto") {
      return { ok: false, code: "VALIDATION_FAILED", message: "Endpoint này hiện chỉ hỗ trợ mode=auto; submit Studio thuộc VE2E-07/08." };
    }
    if (!(await this.assertWriteAccess(input.projectId, userId, role))) return notFoundProject;
    if (Boolean(input.sourceId?.trim()) === Boolean(input.source)) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Cần cung cấp đúng một trong sourceId hoặc source" };
    }
    // VE2E-40: validated before any row (source/run) is created.
    const backgroundSegments = parseBackgroundSegmentsSetting(input.backgroundSegments, backgroundSegmentBoundsFromEnv());
    if (!backgroundSegments.ok) return { ok: false, code: "VALIDATION_FAILED", message: backgroundSegments.message };

    const profile = await this.prisma.automationProfileVersion.findUnique({ where: { id: input.automationProfileId } });
    if (!profile) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy automation profile", status: 404 };
    if (profile.projectId && profile.projectId !== input.projectId) {
      return { ok: false, code: "VALIDATION_FAILED", message: "automationProfileId không thuộc dự án này" };
    }

    const contentConfig = asAccountRef(profile.contentConfig);
    const voiceConfig = asVoiceRef(profile.voiceConfig);
    const mediaConfig = asAccountRef(profile.mediaConfig);
    const renderConfig = asRenderRef(profile.renderConfig);
    if (!contentConfig || !voiceConfig?.voiceId || !mediaConfig || !renderConfig) {
      return {
        ok: false,
        code: "PROVIDER_NOT_CONFIGURED",
        message: "Automation profile thiếu contentConfig/voiceConfig(voiceId)/mediaConfig/renderConfig cần cho Auto — cập nhật profile trước khi submit.",
        status: 503,
      };
    }
    const preflight = await this.renderPreflight(renderConfig.providerAccountId, renderConfig.templateSnapshotId, true);
    if (!preflight.ok) return preflight;

    let sourceVersionId: string;
    if (input.sourceId) {
      const source = await this.prisma.sourceVersion.findUnique({ where: { id: input.sourceId } });
      if (!source || source.projectId !== input.projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy nguồn trong dự án này", status: 404 };
      sourceVersionId = source.id;
    } else {
      const created = await this.sources.create(input.projectId, userId, role, input.source!);
      if (created === "forbidden") return notFoundProject;
      if (created === "invalid") return { ok: false, code: "VALIDATION_FAILED", message: "Dữ liệu nguồn không hợp lệ" };
      if (created === "ssrf_blocked") return { ok: false, code: "SSRF_BLOCKED", message: "URL bị chặn (localhost/private/không hỗ trợ scheme)", status: 400 };
      sourceVersionId = created.id;
    }

    // A fixed segment count is part of what the run produces, so it is part of the dedupe key; the
    // default auto setting is left out so the fingerprint of an auto submit is unchanged from before VE2E-40.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({
        projectId: input.projectId,
        automationProfileId: input.automationProfileId,
        profileVersion: profile.version,
        sourceVersionId,
        ...(backgroundSegments.value.mode === "fixed" ? { backgroundSegments: backgroundSegments.value } : {}),
      }))
      .digest("hex");

    let run: WorkflowRun;
    try {
      run = await this.prisma.workflowRun.create({
        data: {
          projectId: input.projectId,
          mode: "auto",
          automationProfileVersionId: input.automationProfileId,
          sourceVersionId,
          requestFingerprint: fingerprint,
          createdByUserId: userId,
          status: "draft",
          backgroundSegments: backgroundSegments.value as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.workflowRun.findUnique({ where: { requestFingerprint: fingerprint } });
        if (existing) {
          return { ok: true, data: { id: existing.id, status: existing.status, pollUrl: `/video-productions/${existing.id}`, eventsUrl: `/video-productions/${existing.id}/events` } };
        }
      }
      throw error;
    }
    return { ok: true, data: { id: run.id, status: run.status, pollUrl: `/video-productions/${run.id}`, eventsUrl: `/video-productions/${run.id}/events` } };
  }

  /**
   * VE2E-22: every run created by `submit()` belongs to a `Project` that
   * `setupAutoProfile()` provisioned solely for that one run — there is no reuse of an
   * existing project across separate Auto submits from `JobNewPage`. Filtering strictly
   * by a single `projectId` would therefore only ever return the one run that project
   * was created for, which does not solve "let the operator find a run again after
   * navigating away". `projectId` stays supported (useful for a caller that already
   * knows which project it wants, e.g. a future per-channel view), but omitting it
   * returns every Auto run the caller themselves created, across all of their
   * self-provisioned projects — this is the actual fix for the reported gap.
   */
  async list(userId: string, role: "admin" | "staff", projectId?: string): Promise<VideoProductionOutcome<VideoProductionListItemResponse[]>> {
    if (projectId) {
      if (!(await this.assertReadAccess(projectId, userId, role))) return notFoundProject;
    }
    const runs = await this.prisma.workflowRun.findMany({
      where: { mode: "auto", deletedAt: null, ...(projectId ? { projectId } : { createdByUserId: userId }) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, projectId: true, status: true, sourceVersionId: true, lastError: true, createdAt: true, updatedAt: true,
        createdBy: { select: { displayName: true } },
        sourceVersion: {
          select: {
            type: true, rawText: true, originRef: true,
            scriptDraftVersions: { orderBy: { version: "desc" }, take: 1, select: { title: true, caption: true } },
          },
        },
      },
    });
    if (runs.length === 0) return { ok: true, data: [] };
    const renderRows = await this.prisma.renderJob.findMany({
      where: { workflowRunId: { in: runs.map((run) => run.id) } },
      orderBy: { createdAt: "desc" },
      select: { workflowRunId: true, resultUrl: true, snapshotUrl: true, costAmount: true, costCurrency: true, renderDurationMs: true },
    });
    const latestRenderByRun = new Map<string, (typeof renderRows)[number]>();
    for (const row of renderRows) {
      if (row.workflowRunId && !latestRenderByRun.has(row.workflowRunId)) latestRenderByRun.set(row.workflowRunId, row);
    }
    const queueStates = await this.queueStatus.workflowQueueStates(runs);
    return {
      ok: true,
      data: runs.map((run) => {
        const render = latestRenderByRun.get(run.id) ?? null;
        const source = run.sourceVersion;
        const script = source?.scriptDraftVersions[0];
        const sourceTitle = source?.type === "article_url"
          ? source.originRef
          : source?.rawText?.trim().split(/\r?\n/)[0];
        return {
          id: run.id,
          projectId: run.projectId,
          status: run.status,
          sourceVersionId: run.sourceVersionId,
          title: (script?.title?.trim() || sourceTitle?.trim() || null)?.slice(0, 160) ?? null,
          caption: script?.caption?.trim() || null,
          sourceType: source?.type ?? null,
          createdByName: run.createdBy?.displayName ?? null,
          resultUrl: render?.resultUrl ?? null,
          snapshotUrl: render?.snapshotUrl ?? null,
          costAmount: render?.costAmount ? render.costAmount.toString() : null,
          costCurrency: render?.costCurrency ?? null,
          renderDurationMs: render?.renderDurationMs ?? null,
          lastError: (run.lastError as VideoProductionListItemResponse["lastError"]) ?? null,
          queue: queueStates.get(run.id)!,
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
        };
      }),
    };
  }

  /** Hide one finished/stopped Auto run while retaining its render and provider audit records. */
  async remove(id: string, userId: string, role: "admin" | "staff"): Promise<VideoProductionOutcome<{ deleted: true }>> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id }, select: { id: true, mode: true, projectId: true, createdByUserId: true, status: true, deletedAt: true } });
    if (!run || run.mode !== "auto" || run.deletedAt || run.createdByUserId !== userId) return notFoundRun;
    if (!(await this.assertReadAccess(run.projectId, userId, role))) return notFoundRun;
    if (!removableStatuses.includes(run.status as (typeof removableStatuses)[number])) {
      return { ok: false, code: "INVALID_STATE", message: "Video đang xử lý; chỉ có thể xóa khi đã hoàn tất hoặc dừng.", status: 409 };
    }
    const updated = await this.prisma.workflowRun.updateMany({ where: { id, status: run.status, deletedAt: null }, data: { deletedAt: new Date() } });
    if (updated.count === 0) return { ok: false, code: "INVALID_STATE", message: "Trạng thái video vừa thay đổi. Hãy tải lại rồi thử xóa.", status: 409 };
    return { ok: true, data: { deleted: true } };
  }

  /**
   * Re-queues one stuck Auto run for the background worker to pick up again
   * (`WorkflowRunnerService.processOneDraft()` only claims `status: "draft"` rows). This is a
   * user-initiated action, so it always resets `attempts` back to 1 regardless of how many
   * automatic transient-failure retries already happened - a manual retry the user explicitly
   * asked for should get its own fresh allowance, not immediately re-block because the automatic
   * counter was already at `AutomationProfileVersion.retryPolicy.maxAttempts`. The pipeline itself
   * (`WorkflowRunnerService.runPipeline`) re-enters from its first step, but reuses an already-
   * approved script and any scene's already-generated (`current`) audio instead of regenerating
   * them, so a run that failed at e.g. the media step does not re-pay for script/voice again.
   */
  async retry(id: string, userId: string, role: "admin" | "staff"): Promise<VideoProductionOutcome<{ retried: true }>> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id }, select: { id: true, mode: true, projectId: true, createdByUserId: true, status: true, deletedAt: true } });
    if (!run || run.mode !== "auto" || run.deletedAt || run.createdByUserId !== userId) return notFoundRun;
    if (!(await this.assertReadAccess(run.projectId, userId, role))) return notFoundRun;
    if (!retriableStatuses.includes(run.status as (typeof retriableStatuses)[number])) {
      return { ok: false, code: "INVALID_STATE", message: "Chỉ có thể làm lại video đã thất bại, bị chặn, hoặc cần xử lý thủ công.", status: 409 };
    }
    const updated = await this.prisma.workflowRun.updateMany({
      where: { id, status: run.status, deletedAt: null },
      data: { status: "draft", attempts: 1, lastError: Prisma.JsonNull },
    });
    if (updated.count === 0) return { ok: false, code: "INVALID_STATE", message: "Trạng thái video vừa thay đổi. Hãy tải lại rồi thử lại.", status: 409 };
    return { ok: true, data: { retried: true } };
  }

  /**
   * VE2E-62: removes a run that is still WAITING in the queue (`draft`) from it. Compare-and-set on `status: draft`, so a run the
   * worker already claimed (`source_ready`...) is never cancelled mid-pipeline here (-> 409). The worker only claims `draft`, so
   * once `cancelled` the run is never picked up and every later queued run moves up one position. The row stays (audit) and is
   * deletable like any other `cancelled` run.
   */
  async cancelQueued(id: string, userId: string, role: "admin" | "staff"): Promise<VideoProductionOutcome<{ cancelled: true }>> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id }, select: { id: true, mode: true, projectId: true, createdByUserId: true, status: true, deletedAt: true } });
    if (!run || run.mode !== "auto" || run.deletedAt || run.createdByUserId !== userId) return notFoundRun;
    if (!(await this.assertReadAccess(run.projectId, userId, role))) return notFoundRun;
    const updated = await this.prisma.workflowRun.updateMany({ where: { id, status: "draft", deletedAt: null }, data: { status: "cancelled" } });
    if (updated.count === 0) return { ok: false, code: "INVALID_STATE", message: "Video đã bắt đầu chạy hoặc không còn trong hàng chờ nên không thể hủy khỏi hàng đợi.", status: 409 };
    return { ok: true, data: { cancelled: true } };
  }

  async get(id: string, userId: string, role: "admin" | "staff"): Promise<VideoProductionOutcome<VideoProductionResponse>> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id } });
    if (!run || run.deletedAt) return notFoundRun;
    if (!(await this.assertReadAccess(run.projectId, userId, role))) return notFoundRun;
    let scriptDraftVersionId: string | null = null;
    if (run.sourceVersionId) {
      const approved = await this.prisma.scriptDraftVersion.findFirst({ where: { sourceVersionId: run.sourceVersionId, status: "approved" }, orderBy: { version: "desc" } });
      scriptDraftVersionId = approved?.id ?? null;
    }
    const renderJob = await this.prisma.renderJob.findFirst({ where: { workflowRunId: run.id }, orderBy: { createdAt: "desc" } });
    // VE2E-40: auto resolves against the intake target duration (the pinned profile version's durationSec).
    const backgroundSetting = readBackgroundSegmentsSetting(run.backgroundSegments);
    const profile = run.automationProfileVersionId
      ? await this.prisma.automationProfileVersion.findUnique({ where: { id: run.automationProfileVersionId }, select: { durationSec: true } })
      : null;
    const sourcingSteps = await this.prisma.stepRun.findMany({ where: { workflowRunId: run.id, stepKey: "media_plan_diagnostics" }, orderBy: [{ attempt: "desc" }], take: 1 });
    const sourcingOutput = sourcingSteps[0]?.outputRef as { segments?: unknown; apifyUsage?: unknown; visionUsage?: unknown } | null | undefined;
    const mediaSourcing = Array.isArray(sourcingOutput?.segments) ? (sourcingOutput!.segments as MediaPlanSegmentDiagnostics[]) : null;
    const apifyUsage = sourcingOutput?.apifyUsage && typeof sourcingOutput.apifyUsage === "object" ? (sourcingOutput.apifyUsage as MediaPlanApifyUsage) : null;
    const visionUsage = sourcingOutput?.visionUsage && typeof sourcingOutput.visionUsage === "object" ? (sourcingOutput.visionUsage as MediaPlanVisionUsage) : null;
    const budgetSteps = await this.prisma.stepRun.findMany({ where: { workflowRunId: run.id, stepKey: "duration_budget" }, orderBy: [{ attempt: "desc" }], take: 1 });
    const budgetOutput = budgetSteps?.[0]?.outputRef as Record<string, unknown> | null | undefined;
    const durationBudget = budgetOutput && typeof budgetOutput.targetSec === "number" ? (budgetOutput as unknown as DurationBudgetDiagnostics) : null;
    const gateSteps = await this.prisma.stepRun.findMany({ where: { workflowRunId: run.id, stepKey: "quality_gate" }, orderBy: [{ attempt: "desc" }], take: 1 });
    const gateOutput = gateSteps?.[0]?.outputRef as Record<string, unknown> | null | undefined;
    const qualityGate = gateOutput && Array.isArray(gateOutput.checks) ? (gateOutput as unknown as QualityGateDiagnostics) : null;
    return {
      ok: true,
      data: {
        id: run.id,
        projectId: run.projectId,
        mode: run.mode,
        status: run.status,
        attempts: run.attempts,
        sourceVersionId: run.sourceVersionId,
        scriptDraftVersionId,
        renderJobId: renderJob?.id ?? null,
        resultUrl: renderJob?.resultUrl ?? null,
        lastError: (run.lastError as VideoProductionResponse["lastError"]) ?? null,
        backgroundSegments: { setting: backgroundSetting, range: resolveBackgroundSegmentRange(backgroundSetting, profile?.durationSec ?? null) },
        mediaSourcing,
        apifyUsage,
        visionUsage,
        durationBudget,
        qualityGate,
        queue: (await this.queueStatus.workflowQueueStates([run])).get(run.id)!,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      },
    };
  }

  /** Poll-based progress feed (§5 allows SSE hoặc poll) — every `StepRun` this run has recorded, oldest first. */
  async listEvents(id: string, userId: string, role: "admin" | "staff"): Promise<VideoProductionOutcome<WorkflowStepEventResponse[]>> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id } });
    if (!run || run.deletedAt) return notFoundRun;
    if (!(await this.assertReadAccess(run.projectId, userId, role))) return notFoundRun;
    const steps = await this.prisma.stepRun.findMany({ where: { workflowRunId: id }, orderBy: [{ createdAt: "asc" }] });
    return {
      ok: true,
      data: steps.map((step) => ({
        stepKey: step.stepKey,
        status: step.status,
        attempt: step.attempt,
        error: (step.error as { code: string; message: string } | null) ?? null,
        startedAt: step.startedAt?.toISOString() ?? null,
        endedAt: step.endedAt?.toISOString() ?? null,
      })),
    };
  }
}
