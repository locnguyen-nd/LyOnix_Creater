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
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import type { WorkflowRun } from "@lyonix/db";
import { canAccessProject, canWriteProjectResource } from "@lyonix/domain";
import type { ErrorCode, VideoProductionResponse, VideoProductionSubmitRequest, VideoProductionSubmitResponse, WorkflowStepEventResponse } from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { SourcesService } from "./sources.service.js";
import { asAccountRef, asRenderRef, asVoiceRef } from "./workflow-runner.service.js";

export type VideoProductionOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

const notFoundProject = { ok: false as const, code: "NOT_FOUND" as const, message: "Không tìm thấy dự án", status: 404 };
const notFoundRun = { ok: false as const, code: "NOT_FOUND" as const, message: "Không tìm thấy video production", status: 404 };

@Injectable()
export class VideoProductionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(SourcesService) private readonly sources: SourcesService,
  ) {}

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

    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ projectId: input.projectId, automationProfileId: input.automationProfileId, profileVersion: profile.version, sourceVersionId }))
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

  async get(id: string, userId: string, role: "admin" | "staff"): Promise<VideoProductionOutcome<VideoProductionResponse>> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id } });
    if (!run) return notFoundRun;
    if (!(await this.assertReadAccess(run.projectId, userId, role))) return notFoundRun;
    let scriptDraftVersionId: string | null = null;
    if (run.sourceVersionId) {
      const approved = await this.prisma.scriptDraftVersion.findFirst({ where: { sourceVersionId: run.sourceVersionId, status: "approved" }, orderBy: { version: "desc" } });
      scriptDraftVersionId = approved?.id ?? null;
    }
    const renderJob = await this.prisma.renderJob.findFirst({ where: { workflowRunId: run.id }, orderBy: { createdAt: "desc" } });
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
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      },
    };
  }

  /** Poll-based progress feed (§5 allows SSE hoặc poll) — every `StepRun` this run has recorded, oldest first. */
  async listEvents(id: string, userId: string, role: "admin" | "staff"): Promise<VideoProductionOutcome<WorkflowStepEventResponse[]>> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id } });
    if (!run) return notFoundRun;
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
