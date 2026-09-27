/**
 * VE2E-05: server-owned Creatomate render submission, status, webhook inbox and
 * poll/reconcile fallback. The server is the only thing that ever builds the actual
 * Creatomate `modifications` object — the client sends a structured, whitelisted
 * `RenderAssignmentInput[]` (`{modificationKey, kind, ...typed value}`), and every
 * `modificationKey` must exist on the pinned `TemplateSnapshot` or the request is
 * rejected before any provider call. `video`/`image` assignments are resolved to a
 * signed, short-lived `/media-delivery/:token` URL via `MediaDeliveryService` —
 * Creatomate never sees a filesystem path.
 */
import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import { canAccessProject, isTerminalRenderStatus, nextRenderJobStatus, type RenderJobStatus } from "@lyonix/domain";
import {
  ProviderError,
  applyDynamicStyleOverrides,
  buildDynamicComposition,
  extractDynamicStyleFromTemplate,
  getCreatomateRender,
  normalizeCreatomateStatus,
  submitCreatomateRender,
  submitCreatomateSourceRender,
  type CreatomateRenderResult,
  type DynamicSceneInput,
} from "@lyonix/providers";
import type {
  ErrorCode,
  RenderAssignmentInput,
  RenderJobResponse,
  RenderSubmitFromTimelineRequest,
  RenderSubmitRequest,
  TemplateModificationSlotResponse,
  TimelineSceneBindingResponse,
} from "@lyonix/contracts";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { GrantsService } from "./grants.service.js";
import { MediaDeliveryService, publicBaseUrlConfigured } from "./media-delivery.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { buildRenderAssignmentsFromTimeline, resolveSceneBindingsForMapping } from "./timeline-render-mapping.js";

export type RenderOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

/** Render assignment value caps — defense in depth against unbounded payloads reaching Creatomate. */
const MAX_TEXT_LENGTH = 2000;
const MAX_FONT_LENGTH = 60;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/;
const FONT_RE = /^[A-Za-z0-9 _-]+$/;
/** Signed media-delivery token TTL for a render submission — long enough for Creatomate to fetch under load. */
const DELIVERY_TOKEN_TTL_SEC = 3600;
/** Portrait short-form canvas — matches the project's target output shape (1080×1920) regardless of the pinned template's own preview scale. */
const DYNAMIC_RENDER_WIDTH = 1080;
const DYNAMIC_RENDER_HEIGHT = 1920;

const providerErrorMessage: Record<string, string> = {
  PROVIDER_AUTH_INVALID: "Khóa Creatomate bị từ chối. Verify lại tài khoản.",
  PROVIDER_RATE_LIMITED: "Creatomate giới hạn tốc độ, thử lại sau.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Creatomate không tìm thấy template/render này.",
  PROVIDER_TIMEOUT: "Yêu cầu Creatomate hết thời gian chờ.",
  PROVIDER_SCHEMA_INVALID: "Creatomate từ chối payload render.",
};

const mapProviderError = (error: unknown): { code: ErrorCode; message: string; status: number; retryable: boolean } => {
  if (error instanceof ProviderError) {
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_AUTH_INVALID";
    return { code: error.code, message: providerErrorMessage[error.code] ?? "Creatomate từ chối yêu cầu", status: switchable ? 429 : 502, retryable: error.retryable };
  }
  return { code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi Creatomate", status: 502, retryable: true };
};

const clampVolume = (value: number) => Math.max(0, Math.min(200, Math.round(value)));

/** Stable JSON stringify (sorted keys) so the request fingerprint is deterministic regardless of client-side object key order. */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const toJobResponse = (row: {
  id: string; projectId: string; templateSnapshotId: string; status: string; externalJobId: string | null; progress: number | null;
  resultUrl: string | null; snapshotUrl?: string | null; resultExpiresAt: Date | null; attempts: number; requestFingerprint: string; costAmount: Prisma.Decimal | null;
  costCurrency: string | null; renderDurationMs: number | null; lastError: unknown; createdAt: Date; updatedAt: Date;
}): RenderJobResponse => ({
  id: row.id,
  projectId: row.projectId,
  templateSnapshotId: row.templateSnapshotId,
  status: row.status as RenderJobResponse["status"],
  externalJobId: row.externalJobId,
  progress: row.progress,
  resultUrl: row.resultUrl,
  snapshotUrl: row.snapshotUrl ?? null,
  resultExpiresAt: row.resultExpiresAt?.toISOString() ?? null,
  attempts: row.attempts,
  requestFingerprint: row.requestFingerprint,
  costAmount: row.costAmount?.toString() ?? null,
  costCurrency: row.costCurrency,
  renderDurationMs: row.renderDurationMs,
  lastError: row.lastError && typeof row.lastError === "object" ? (row.lastError as { code: string; message: string }) : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class RenderJobsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(CreatomateTemplatesService) private readonly templates: CreatomateTemplatesService,
    @Inject(MediaDeliveryService) private readonly mediaDelivery: MediaDeliveryService,
  ) {}

  private async assertProjectAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return false;
    const grants = await this.grants.forUser(userId, role);
    return canAccessProject(role, grants, projectId);
  }

  /**
   * Resolves the server-owned Creatomate `modifications` object from a whitelisted
   * assignment list, validated against the pinned template snapshot's slots. Returns
   * an outcome instead of throwing so the caller can normalize the error consistently.
   */
  private async buildModifications(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    slots: TemplateModificationSlotResponse[],
    assignments: RenderAssignmentInput[],
  ): Promise<RenderOutcome<Record<string, string>>> {
    const slotByKey = new Map(slots.map((s) => [s.key, s]));
    const modifications: Record<string, string> = {};
    const providedKeys = new Set<string>();
    for (const assignment of assignments) {
      const slot = slotByKey.get(assignment.modificationKey);
      if (!slot) return { ok: false, code: "VALIDATION_FAILED", message: `Modification key không thuộc template: ${assignment.modificationKey}` };
      if (slot.kind !== assignment.kind) return { ok: false, code: "VALIDATION_FAILED", message: `Kind không khớp cho ${assignment.modificationKey}: kỳ vọng ${slot.kind}` };
      providedKeys.add(slot.key);
      if (assignment.kind === "text") {
        const text = assignment.text.trim();
        if (!text || text.length > MAX_TEXT_LENGTH) return { ok: false, code: "VALIDATION_FAILED", message: `Text không hợp lệ cho ${slot.key}` };
        modifications[slot.key] = text;
      } else if (assignment.kind === "video" || assignment.kind === "image" || assignment.kind === "audio") {
        const asset = await this.prisma.mediaAssetVersion.findFirst({ where: { id: assignment.mediaAssetVersionId, deletedAt: null } });
        if (!asset) return { ok: false, code: "NOT_FOUND", message: `Không tìm thấy media asset ${assignment.mediaAssetVersionId}`, status: 404 };
        if (asset.projectId !== projectId) return { ok: false, code: "VALIDATION_FAILED", message: "Media asset không thuộc project này" };
        const issued = await this.mediaDelivery.issueToken(asset.id, userId, role, DELIVERY_TOKEN_TTL_SEC);
        if (issued === "not_configured") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };
        if (!issued || issued === "forbidden") return { ok: false, code: "NOT_FOUND", message: `Không thể cấp delivery URL cho ${assignment.mediaAssetVersionId}`, status: 404 };
        modifications[slot.key] = issued.url;
      } else if (assignment.kind === "color") {
        if (!HEX_COLOR_RE.test(assignment.color)) return { ok: false, code: "VALIDATION_FAILED", message: `Màu không hợp lệ cho ${slot.key}` };
        modifications[slot.key] = assignment.color;
      } else if (assignment.kind === "font") {
        const font = assignment.fontFamily.trim();
        if (!font || font.length > MAX_FONT_LENGTH || !FONT_RE.test(font)) return { ok: false, code: "VALIDATION_FAILED", message: `Font không hợp lệ cho ${slot.key}` };
        modifications[slot.key] = font;
      } else if (assignment.kind === "volume") {
        modifications[slot.key] = `${clampVolume(assignment.volumePercent)}%`;
      }
    }
    const missingRequired = slots.filter((slot) => slot.required && !providedKeys.has(slot.key)).map((slot) => slot.key);
    if (missingRequired.length > 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: `Thiếu modification bắt buộc: ${missingRequired.join(", ")}` };
    }
    return { ok: true, data: modifications };
  }

  /**
   * `workflowRunId` is intentionally NOT part of the public `RenderSubmitRequest`
   * contract (a client could otherwise spoof linking its render onto an unrelated
   * run) — it is only ever passed by `WorkflowRunnerService`, which calls this method
   * directly (not over HTTP) from the trusted background orchestrator.
   */
  async submit(projectId: string, userId: string, role: "admin" | "staff", input: RenderSubmitRequest, workflowRunId?: string): Promise<RenderOutcome<RenderJobResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    // Preflight: provider account usable and PUBLIC_BASE_URL reachable *before* touching the DB or Creatomate — no charge on a preflight failure.
    const account = await this.templates.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!publicBaseUrlConfigured()) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };

    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: input.templateSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    if (snapshot.providerAccountId !== input.providerAccountId) {
      return { ok: false, code: "VALIDATION_FAILED", message: "providerAccountId không khớp với template snapshot đã pin" };
    }
    const slots = Array.isArray(snapshot.modifications) ? (snapshot.modifications as unknown as TemplateModificationSlotResponse[]) : [];
    if (!input.assignments?.length) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu assignments cho render" };

    const built = await this.buildModifications(projectId, userId, role, slots, input.assignments);
    if (!built.ok) return built;
    const modifications = built.data;

    // Fingerprint must be computed from the client's stable raw input, not the resolved
    // `modifications` object: video/image assignments resolve through `issueToken()`, which
    // mints a fresh signed URL (random token + expiry) on every call. Hashing that volatile
    // URL made an identical duplicate request produce a different fingerprint each time,
    // defeating the unique-constraint dedupe and double-charging Creatomate.
    const fingerprint = createHash("sha256")
      .update(stableStringify({ projectId, templateSnapshotId: input.templateSnapshotId, providerAccountId: input.providerAccountId, outputFormat: input.outputFormat ?? null, idempotencyKey: input.idempotencyKey ?? null, assignments: input.assignments }))
      .digest("hex");

    return this.createAndSubmitRenderJob(
      { projectId, templateSnapshotId: input.templateSnapshotId, providerAccountId: input.providerAccountId, userId, fingerprint, payload: modifications, workflowRunId },
      (webhookUrl) =>
        submitCreatomateRender(decryptSecret(account.data.encryptedSecret), {
          templateId: snapshot.externalTemplateId,
          modifications,
          webhookUrl,
          ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
        }),
    );
  }

  /**
   * Shared plumbing for both the template-modifications path (`submit`) and the dynamic
   * per-scene composition path (`submitDynamicFromTimeline`): create the `RenderJob` row
   * (idempotent on `requestFingerprint` — a P2002 race returns the winner's row instead of
   * erroring), then call Creatomate exactly once and apply its response through the same
   * monotonic status guard the webhook path uses, so a late webhook can never be regressed
   * by this response (see `submit`'s original comment for why that race matters). `payload`
   * is only ever the *stable* description of what will be sent, stored for audit/debug —
   * never the actual request if that would embed a volatile signed media-delivery URL.
   */
  private async createAndSubmitRenderJob(
    params: { projectId: string; templateSnapshotId: string; providerAccountId: string; userId: string; fingerprint: string; payload: unknown; workflowRunId?: string | undefined },
    callProvider: (webhookUrl: string) => Promise<CreatomateRenderResult>,
  ): Promise<RenderOutcome<RenderJobResponse>> {
    let job: Awaited<ReturnType<typeof this.prisma.renderJob.create>>;
    try {
      job = await this.prisma.renderJob.create({
        data: {
          projectId: params.projectId,
          templateSnapshotId: params.templateSnapshotId,
          providerAccountId: params.providerAccountId,
          requestFingerprint: params.fingerprint,
          webhookToken: randomBytes(24).toString("base64url"),
          status: "accepted",
          modificationsPayload: params.payload as unknown as Prisma.InputJsonValue,
          createdByUserId: params.userId,
          ...(params.workflowRunId ? { workflowRunId: params.workflowRunId } : {}),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.renderJob.findUnique({ where: { requestFingerprint: params.fingerprint } });
        if (existing) return { ok: true, data: toJobResponse(existing) };
      }
      throw error;
    }

    // Only the request that atomically won the fingerprint race actually calls Creatomate.
    const base = process.env.PUBLIC_BASE_URL!.replace(/\/$/, "");
    const webhookUrl = `${base}/api/v1/render-webhooks/creatomate/${job.webhookToken}`;
    try {
      const submitted = await callProvider(webhookUrl);
      const reportedStatus = normalizeCreatomateStatus(submitted.status);
      // The webhook can arrive and complete this job WHILE this submit call is still in
      // flight (Creatomate may call back before the HTTP response reaches us). Re-read the
      // latest persisted status and run it through the same monotonic guard as the webhook
      // path so this response can never regress an already-applied completion/failure.
      const latest = await this.prisma.renderJob.findUnique({ where: { id: job.id } });
      const currentStatus = (latest?.status ?? job.status) as RenderJobStatus;
      const nextStatus = nextRenderJobStatus(currentStatus, reportedStatus);
      job = await this.prisma.renderJob.update({
        where: { id: job.id },
        data: {
          externalJobId: submitted.externalJobId,
          submittedAt: new Date(),
          ...(nextStatus ? { status: nextStatus, progress: submitted.progress } : {}),
          ...(submitted.snapshotUrl ? { snapshotUrl: submitted.snapshotUrl } : {}),
        },
      });
    } catch (error) {
      const mapped = mapProviderError(error);
      job = await this.prisma.renderJob.update({
        where: { id: job.id },
        data: { status: "failed", lastError: { code: mapped.code, message: mapped.message } as unknown as Prisma.InputJsonValue },
      });
      return { ok: false, ...mapped };
    }
    return { ok: true, data: toJobResponse(job) };
  }

  /**
   * VE2E-07: submits a render from an approved Studio `TimelineVersion` instead of a raw
   * client-supplied assignments array. Resolves the timeline's ordered scene/audio
   * bindings into the same whitelisted `RenderAssignmentInput[]` shape `submit()` already
   * validates and delegates to it unchanged - no duplicated Creatomate-call/idempotency/
   * webhook logic, this is purely an alternate input-building path.
   */
  async submitFromTimelineVersion(
    projectId: string,
    timelineVersionId: string,
    userId: string,
    role: "admin" | "staff",
    input: RenderSubmitFromTimelineRequest,
  ): Promise<RenderOutcome<RenderJobResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (timeline.status !== "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline chưa được duyệt", status: 409 };
    if (!timeline.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Timeline chưa chọn template" };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: timeline.templateSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    const slots = Array.isArray(snapshot.modifications) ? (snapshot.modifications as unknown as TemplateModificationSlotResponse[]) : [];
    const scenes = (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, projectId, scenes);
    const optionValues = (timeline.optionValues && typeof timeline.optionValues === "object" ? timeline.optionValues : {}) as Record<string, string>;
    const built = buildRenderAssignmentsFromTimeline(slots, resolved, optionValues);
    if (built.missingRequiredModificationKeys.length > 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: `Thiếu modification bắt buộc: ${built.missingRequiredModificationKeys.join(", ")}` };
    }
    return this.submit(projectId, userId, role, {
      templateSnapshotId: timeline.templateSnapshotId,
      providerAccountId: input.providerAccountId,
      assignments: built.assignments,
      ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  /**
   * Shared by `submitDynamicFromTimeline` (submits to Creatomate) and `previewDynamicComposition`
   * (VE2E-13, read-only Studio preview — never calls Creatomate, never creates a `RenderJob`):
   * resolves a timeline's own scenes into the same fully dynamic Creatomate `source` document
   * whose scene count and per-scene duration come entirely from this project's own data; the
   * pinned `TemplateSnapshot` is only read for its visual style
   * (`extractDynamicStyleFromTemplate`), never for its element count. Building this JSON never
   * calls Creatomate itself (`buildDynamicComposition` is pure local logic) — the only side
   * effect is minting short-lived signed `/media-delivery/:token` URLs (free, not a provider
   * call) so the returned `source` is directly usable by the browser Preview SDK or the real
   * render submit, whichever the caller does next.
   *
   * A scene the user marked `excluded`, or one still missing narration audio or an assigned
   * image/video, is dropped rather than blocking the whole result — per-scene voice/media
   * generation in Studio is inherently incremental, and requiring every single scene to be
   * ready before even a preview could render would defeat the "see it as you go" point of a
   * live editor preview. If nothing is renderable yet, the whole call is rejected instead of
   * building an empty video/composition.
   */
  private async resolveDynamicComposition(
    projectId: string,
    timelineVersionId: string,
    userId: string,
    role: "admin" | "staff",
    outputFormat?: "mp4" | "mov" | "gif",
  ): Promise<
    RenderOutcome<{
      templateSnapshotId: string;
      source: Record<string, unknown>;
      style: ReturnType<typeof applyDynamicStyleOverrides>;
      renderable: Awaited<ReturnType<typeof resolveSceneBindingsForMapping>>;
      totalSceneCount: number;
    }>
  > {
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (!timeline.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Timeline chưa chọn template (dùng để lấy style hiển thị)" };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: timeline.templateSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };

    const scenes = (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, projectId, scenes);
    const audioVersionIds = [...new Set(resolved.map((scene) => scene.audioVersionId).filter((sceneId): sceneId is string => Boolean(sceneId)))];
    const audioRows = audioVersionIds.length
      ? await this.prisma.audioVersion.findMany({ where: { id: { in: audioVersionIds } }, select: { id: true, durationMs: true } })
      : [];
    const audioDurationById = new Map(audioRows.map((row) => [row.id, row.durationMs]));

    const renderable = [...resolved]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .filter((scene) => !scene.excluded && scene.audioVersionId && scene.audioMediaAssetVersionId && scene.mediaAssetVersionId && scene.mediaKind)
      .filter((scene) => (audioDurationById.get(scene.audioVersionId!) ?? 0) > 0);
    if (renderable.length === 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Chưa có cảnh nào đủ audio + media để render — tạo voice/gán media rồi thử lại" };
    }

    const dynamicScenes: DynamicSceneInput[] = [];
    for (const scene of renderable) {
      const mediaIssued = await this.mediaDelivery.issueToken(scene.mediaAssetVersionId!, userId, role, DELIVERY_TOKEN_TTL_SEC);
      if (mediaIssued === "not_configured") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };
      if (!mediaIssued || mediaIssued === "forbidden") continue;
      const audioIssued = await this.mediaDelivery.issueToken(scene.audioMediaAssetVersionId!, userId, role, DELIVERY_TOKEN_TTL_SEC);
      if (audioIssued === "not_configured") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };
      if (!audioIssued || audioIssued === "forbidden") continue;
      dynamicScenes.push({
        sceneId: scene.sceneId,
        mediaUrl: mediaIssued.url,
        mediaKind: scene.mediaKind === "video" ? "video" : "image",
        text: (scene.screenTextOverride ?? scene.fallbackScreenText ?? "").trim(),
        audioUrl: audioIssued.url,
        audioDurationMs: audioDurationById.get(scene.audioVersionId!) ?? 0,
      });
    }
    if (dynamicScenes.length === 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Không cấp được delivery URL cho cảnh nào — kiểm tra lại media/audio" };
    }

    // VE2E-26: schema-backed, server-validated Studio overrides (font/color/animation-on-off)
    // layered on top of the template-derived base style — persisted in this same
    // TimelineVersion's own `optionValues` (already validated at save time by
    // `TimelineVersionsService`), so preview and the final render always agree because both
    // call this exact same method with the exact same saved timeline row.
    const optionValues = (timeline.optionValues && typeof timeline.optionValues === "object" ? (timeline.optionValues as Record<string, string>) : {});
    const style = applyDynamicStyleOverrides(extractDynamicStyleFromTemplate(snapshot.rawTemplate), optionValues);
    const source = buildDynamicComposition(dynamicScenes, style, { width: DYNAMIC_RENDER_WIDTH, height: DYNAMIC_RENDER_HEIGHT, outputFormat });
    return { ok: true, data: { templateSnapshotId: timeline.templateSnapshotId, source, style, renderable, totalSceneCount: scenes.length } };
  }

  /**
   * Renders every scene the script/Studio actually produced instead of only however many
   * `Image-N`/`Subtitles-N`/`Voiceover-N` slots the pinned template's own author happened to
   * draw (`submitFromTimelineVersion`'s hard limit) — see `resolveDynamicComposition` for how
   * the `source` document itself is built.
   */
  async submitDynamicFromTimeline(
    projectId: string,
    timelineVersionId: string,
    userId: string,
    role: "admin" | "staff",
    input: RenderSubmitFromTimelineRequest,
  ): Promise<RenderOutcome<RenderJobResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const account = await this.templates.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!publicBaseUrlConfigured()) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };

    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (timeline.status !== "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline chưa được duyệt", status: 409 };

    const resolvedComposition = await this.resolveDynamicComposition(projectId, timelineVersionId, userId, role, input.outputFormat);
    if (!resolvedComposition.ok) return resolvedComposition;
    const { templateSnapshotId, source, style, renderable } = resolvedComposition.data;

    // Fingerprint from each included scene's stable identifiers (never the resolved signed
    // delivery URLs, which mint a fresh random token every call — see `submit`'s own comment
    // for the VE2E-05 bug this pattern already fixed once for the template-based path) plus
    // the resolved (template + Studio override) `style` object — VE2E-26: `style` has no
    // volatile fields (unlike `source`, whose media/audio `source` URLs are signed and mint
    // fresh every call, so hashing `source` itself would reintroduce that same VE2E-05 bug),
    // so a style-only change (e.g. changing the caption font) still produces a distinct
    // fingerprint and a genuinely new submit, instead of silently replaying the previous job.
    const fingerprint = createHash("sha256")
      .update(
        stableStringify({
          mode: "dynamic",
          projectId,
          timelineVersionId,
          providerAccountId: input.providerAccountId,
          outputFormat: input.outputFormat ?? null,
          style,
          scenes: renderable.map((scene) => ({
            sceneId: scene.sceneId,
            mediaAssetVersionId: scene.mediaAssetVersionId,
            audioVersionId: scene.audioVersionId,
            text: (scene.screenTextOverride ?? scene.fallbackScreenText ?? "").trim(),
          })),
        }),
      )
      .digest("hex");

    return this.createAndSubmitRenderJob(
      { projectId, templateSnapshotId, providerAccountId: input.providerAccountId, userId, fingerprint, payload: source },
      (webhookUrl) => submitCreatomateSourceRender(decryptSecret(account.data.encryptedSecret), { source, webhookUrl }),
    );
  }

  /**
   * VE2E-13: read-only Studio preview of the exact `source` JSON a dynamic render would
   * submit right now — no Creatomate call, no `RenderJob` row, works on a draft (not yet
   * approved) timeline unlike `submitDynamicFromTimeline`, since the whole point is to let
   * the Creatomate Preview SDK show live edits before anything is billable. Never requires a
   * render provider account: composing the JSON is pure LyOnix logic (`resolveDynamicComposition`),
   * and the browser SDK itself only needs a separate preview public token (see
   * `creatomate-preview.config.ts`), never the server-held render API secret.
   */
  async previewDynamicComposition(
    projectId: string,
    timelineVersionId: string,
    userId: string,
    role: "admin" | "staff",
  ): Promise<RenderOutcome<{ ready: boolean; source: Record<string, unknown> | null; renderableSceneCount: number; totalSceneCount: number; missingReason: string | null }>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const resolved = await this.resolveDynamicComposition(projectId, timelineVersionId, userId, role);
    if (!resolved.ok) {
      // A "not ready yet" preview (no renderable scene, no template pinned) is not an error the
      // Studio UI should surface as a banner — it is the expected state while a user is still
      // assigning media/voice. Only a real lookup failure (timeline/project not found) is a hard error.
      if (resolved.code === "VALIDATION_FAILED") {
        return { ok: true, data: { ready: false, source: null, renderableSceneCount: 0, totalSceneCount: 0, missingReason: resolved.message } };
      }
      return resolved;
    }
    return {
      ok: true,
      data: {
        ready: true,
        source: resolved.data.source,
        renderableSceneCount: resolved.data.renderable.length,
        totalSceneCount: resolved.data.totalSceneCount,
        missingReason: null,
      },
    };
  }

  async get(id: string, userId: string, role: "admin" | "staff"): Promise<RenderOutcome<RenderJobResponse>> {
    const row = await this.prisma.renderJob.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy render job", status: 404 };
    if (!(await this.assertProjectAccess(row.projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy render job", status: 404 };
    if (!isTerminalRenderStatus(row.status as RenderJobStatus) && row.externalJobId) {
      const reconciled = await this.reconcileOne(row.id);
      if (reconciled.ok) return { ok: true, data: reconciled.data };
    }
    return { ok: true, data: toJobResponse(row) };
  }

  /** Applies the monotonic status guard and persists a Creatomate-reported result. Never lets a terminal state regress. */
  private async applyStatus(jobId: string, current: RenderJobStatus, incoming: { status: RenderJobStatus; url?: string | null; progress?: number | null; errorMessage?: string | null; renderDurationMs?: number | null; snapshotUrl?: string | null }) {
    const nextStatus = nextRenderJobStatus(current, incoming.status);
    if (!nextStatus) return null; // stale/out-of-order/duplicate — no-op, current row already reflects the latest applied state.
    const data: Prisma.RenderJobUpdateInput = { status: nextStatus };
    if (incoming.progress !== undefined && incoming.progress !== null) data.progress = incoming.progress;
    // VE2E-19: Creatomate can report a preview frame before the render is fully complete — capture it whenever present, not only at completion.
    if (incoming.snapshotUrl) data.snapshotUrl = incoming.snapshotUrl;
    if (nextStatus === "completed") {
      data.resultUrl = incoming.url ?? null;
      data.completedAt = new Date();
      if (incoming.renderDurationMs != null) data.renderDurationMs = incoming.renderDurationMs;
    }
    if (nextStatus === "failed") {
      data.completedAt = new Date();
      data.lastError = { code: "PROVIDER_SUBMIT_UNKNOWN", message: incoming.errorMessage ?? "Creatomate render failed" } as unknown as Prisma.InputJsonValue;
    }
    return this.prisma.renderJob.update({ where: { id: jobId }, data });
  }

  /** Poll/reconcile fallback: fetches live Creatomate status for one job and applies it through the same monotonic guard as the webhook path. Used both by `GET` status (best-effort) and the manual reconcile endpoint. */
  async reconcileOne(id: string): Promise<RenderOutcome<RenderJobResponse>> {
    const row = await this.prisma.renderJob.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy render job", status: 404 };
    if (isTerminalRenderStatus(row.status as RenderJobStatus) || !row.externalJobId) return { ok: true, data: toJobResponse(row) };
    const account = await this.prisma.providerAccount.findFirst({ where: { id: row.providerAccountId, deletedAt: null } });
    if (!account) return { ok: true, data: toJobResponse(row) };
    try {
      const remote = await getCreatomateRender(decryptSecret(account.encryptedSecret), row.externalJobId);
      const updated = await this.applyStatus(row.id, row.status as RenderJobStatus, {
        status: normalizeCreatomateStatus(remote.status),
        url: remote.url,
        progress: remote.progress,
        errorMessage: remote.errorMessage,
        renderDurationMs: remote.renderDurationMs,
        snapshotUrl: remote.snapshotUrl,
      });
      return { ok: true, data: toJobResponse(updated ?? row) };
    } catch {
      // Reconcile is best-effort; a transient failure just leaves the last known status in place.
      return { ok: true, data: toJobResponse(row) };
    }
  }

  /** Poll/reconcile fallback across every non-terminal job (webhook-missed recovery). Intended to be invoked periodically by an external scheduler — see handoff "known-limitation" for why no in-process cron is wired in this task. */
  async reconcilePending(): Promise<{ reconciled: number }> {
    const rows = await this.prisma.renderJob.findMany({ where: { status: { notIn: ["completed", "failed", "cancelled"] }, externalJobId: { not: null } } });
    for (const row of rows) await this.reconcileOne(row.id);
    return { reconciled: rows.length };
  }

  /**
   * Webhook inbox: `token` authenticates the callback (unguessable per-job secret
   * embedded in the `webhook_url` given to Creatomate at submit time — Creatomate has
   * no documented signature scheme of its own). Every payload is recorded by its
   * content fingerprint before being applied, so an exact-duplicate delivery
   * (Creatomate retries webhooks) is a guaranteed no-op.
   */
  async handleWebhook(token: string, rawBody: unknown): Promise<RenderOutcome<{ received: true }>> {
    const job = await this.prisma.renderJob.findUnique({ where: { webhookToken: token } });
    if (!job) return { ok: false, code: "WEBHOOK_INVALID", message: "Webhook token không hợp lệ", status: 404 };
    const eventFingerprint = createHash("sha256").update(`${job.id}:${stableStringify(rawBody)}`).digest("hex");
    try {
      await this.prisma.renderWebhookEvent.create({ data: { renderJobId: job.id, eventFingerprint, payload: (rawBody ?? {}) as Prisma.InputJsonValue } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { ok: true, data: { received: true } }; // exact duplicate delivery — no-op
      throw error;
    }
    const record = (rawBody ?? {}) as Record<string, unknown>;
    const rawStatus = typeof record.status === "string" ? record.status : "";
    const normalized = ["planned", "waiting", "transcribing", "rendering", "succeeded", "failed"].includes(rawStatus)
      ? normalizeCreatomateStatus(rawStatus as Parameters<typeof normalizeCreatomateStatus>[0])
      : null;
    if (normalized) {
      const hasResultUrl = typeof record.url === "string" && record.url.length > 0;
      // Creatomate reporting `succeeded` without a result URL is a malformed/incomplete
      // payload, not a valid completion — completing without a URL would leave the job
      // permanently "done" with nothing to review/export. Treat it as a failure instead so
      // it surfaces (and can be retried/reconciled), rather than silently closing the job.
      const outcome = normalized === "completed" && !hasResultUrl
        ? { status: "failed" as const, errorMessage: "Creatomate báo succeeded nhưng thiếu result URL" }
        : {
            status: normalized,
            url: typeof record.url === "string" ? record.url : null,
            progress: typeof record.progress === "number" ? record.progress : null,
            errorMessage: typeof record.error_message === "string" ? record.error_message : null,
            renderDurationMs: typeof record.render_duration === "number" ? Math.round(record.render_duration * 1000) : null,
            snapshotUrl: typeof record.snapshot_url === "string" ? record.snapshot_url : null,
          };
      const updated = await this.applyStatus(job.id, job.status as RenderJobStatus, outcome);
      await this.prisma.renderWebhookEvent.updateMany({ where: { renderJobId: job.id, eventFingerprint }, data: { appliedStatus: updated?.status ?? null } });
    }
    return { ok: true, data: { received: true } };
  }
}
