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
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { mediaRoot } from "./handoff-workspace.js";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import { canAccessProject, estimateProviderCostUsd, isSafeRelativePath, isTerminalRenderStatus, nextRenderJobStatus, type RenderJobStatus } from "@lyonix/domain";
import {
  ProviderError,
  applyDynamicStyleOverrides,
  buildDynamicCompositionWithWarnings,
  countTemplateSceneSlots,
  extractDynamicStyleFromTemplate,
  getCreatomateRender,
  getOrshotRender,
  normalizeCreatomateStatus,
  readCreatomateCanvas,
  templateResolution,
  submitCreatomateRender,
  submitOrshotRender,
  submitCreatomateSourceRender,
  applyCreatomateFrameRateCap,
  type CreatomateRenderResult,
  type DynamicSceneInput,
} from "@lyonix/providers";
import type {
  ErrorCode,
  OrshotCostEstimateResponse,
  OrshotRenderOptions,
  RenderAssignmentInput,
  RenderEngine,
  RenderJobResponse,
  RenderRouteReason,
  RenderSubmitFromTimelineRequest,
  RenderSubmitRequest,
  TemplateModificationSlotResponse,
  TimelineSceneBindingResponse,
} from "@lyonix/contracts";
import { InternalRenderService } from "./internal-render.service.js";
import { ClipDerivativesService, type ClipDerivativeRequest } from "./clip-derivatives.service.js";
import { CreatomateTemplatesService, type RenderProviderName } from "./creatomate-templates.service.js";
import { GrantsService } from "./grants.service.js";
import { MediaDeliveryService, publicBaseUrlConfigured } from "./media-delivery.service.js";
import { PrismaService } from "./prisma.service.js";
import { fixedSlotPathApplies } from "./render-mode.js";
import { estimateOrshotCost, narrationDurationMs, resolveOrshotPricing, sanitizeOrshotOptions } from "./orshot-render.js";
import { QueueStatusService } from "./queue-status.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { TTS_PROVIDER_DISABLED_VALUE, classifyCreatomateRenderError, slotsWithTtsProvider, templateTtsConflictMessage, ttsProviderOverrideKey, unfilledTtsSlotKeys } from "./template-tts.js";
import { buildRenderAssignmentsFromTimeline, captionOverrideFor, resolveSceneBindingsForMapping, type SceneBindingForMapping } from "./timeline-render-mapping.js";
import { selectSubtitlesForScenes } from "./subtitle-selection.js";

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

const providerErrorMessage = (label: string): Record<string, string> => ({
  PROVIDER_AUTH_INVALID: `Khóa ${label} bị từ chối. Verify lại tài khoản.`,
  PROVIDER_RATE_LIMITED: `${label} giới hạn tốc độ, thử lại sau.`,
  PROVIDER_QUOTA_EXHAUSTED: `Tài khoản ${label} đã hết credit. Nạp thêm credit hoặc đổi gói rồi thử lại.`,
  PROVIDER_CAPABILITY_UNAVAILABLE: `${label} không tìm thấy template/render này.`,
  PROVIDER_TIMEOUT: `Yêu cầu ${label} hết thời gian chờ.`,
  PROVIDER_SCHEMA_INVALID: `${label} từ chối payload render.`,
});

const mapProviderError = (error: unknown, provider: RenderProviderName = "creatomate"): { code: ErrorCode; message: string; status: number; retryable: boolean } => {
  const label = provider === "orshot" ? "Orshot" : "Creatomate";
  if (error instanceof ProviderError) {
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_AUTH_INVALID";
    return { code: error.code, message: providerErrorMessage(label)[error.code] ?? `${label} từ chối yêu cầu (${error.message})`, status: switchable ? 429 : 502, retryable: error.retryable };
  }
  return { code: "PROVIDER_UNAVAILABLE", message: `Lỗi mạng hoặc timeout khi gọi ${label}`, status: 502, retryable: true };
};

/** Orshot only renders a saved template with modifications — it cannot take the fully dynamic `source` composition Creatomate can. */
const ORSHOT_NO_DYNAMIC_MESSAGE = "Orshot chỉ render theo template (số cảnh phải khớp slot template); dùng tài khoản Creatomate cho video có số cảnh khác slot.";

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

/** VE2E-52b: persists what Creatomate reports it actually rendered (only fields present in the response). */
const outputResolutionData = (r: { renderScale?: number | null; width?: number | null; height?: number | null }) => ({
  ...(r.renderScale != null ? { outputRenderScale: r.renderScale } : {}),
  ...(r.width != null ? { outputWidth: Math.round(r.width) } : {}),
  ...(r.height != null ? { outputHeight: Math.round(r.height) } : {}),
});

/** Codes of the QC checks that failed in a stored report (empty when passed / not an internal render). */
const failedQcCodes = (report: unknown): string[] => {
  const checks = report && typeof report === "object" ? (report as { checks?: unknown }).checks : null;
  return Array.isArray(checks) ? checks.filter((c): c is { code: string; ok: boolean } => Boolean(c) && typeof c === "object" && (c as { ok?: unknown }).ok === false && typeof (c as { code?: unknown }).code === "string").map((c) => c.code) : [];
};

const toJobResponse = (row: {
  id: string; projectId: string; templateSnapshotId: string; status: string; externalJobId: string | null; progress: number | null;
  clipsTotal?: number; clipsReady?: number; clipFailures?: unknown;
  resultUrl: string | null; snapshotUrl?: string | null; resultExpiresAt: Date | null; attempts: number; requestFingerprint: string; costAmount: Prisma.Decimal | null;
  costCurrency: string | null; renderDurationMs: number | null; lastError: unknown; createdAt: Date; updatedAt: Date;
  outputRenderScale?: number | null; outputWidth?: number | null; outputHeight?: number | null; canvasWidth?: number | null; canvasHeight?: number | null;
  engine?: string; routeReason?: string | null; fallbackOfJobId?: string | null;
  outputSha256?: string | null; outputBytes?: number | null; outputProfileVersion?: string | null; qcReport?: unknown;
}): RenderJobResponse => ({
  ...(row.outputSha256 ? { outputSha256: row.outputSha256, outputBytes: row.outputBytes ?? null, outputProfileVersion: row.outputProfileVersion ?? null } : {}),
  ...(failedQcCodes(row.qcReport).length ? { qcFailedCodes: failedQcCodes(row.qcReport) } : {}),
  ...(row.engine ? { engine: row.engine as RenderEngine, routeReason: (row.routeReason ?? null) as RenderRouteReason | null, fallbackOfJobId: row.fallbackOfJobId ?? null } : {}),
  outputRenderScale: row.outputRenderScale ?? null,
  outputWidth: row.outputWidth ?? null,
  outputHeight: row.outputHeight ?? null,
  canvasWidth: row.canvasWidth ?? null,
  canvasHeight: row.canvasHeight ?? null,
  id: row.id,
  projectId: row.projectId,
  templateSnapshotId: row.templateSnapshotId,
  status: row.status as RenderJobResponse["status"],
  externalJobId: row.externalJobId,
  progress: row.progress,
  clipPreparation: { clipsTotal: row.clipsTotal ?? 0, clipsReady: row.clipsReady ?? 0, failed: Array.isArray(row.clipFailures) ? row.clipFailures as Array<{ sceneId: string; code: string; message: string }> : [] },
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

/** Why a provider-owned template renders on its provider (Router rule 2, VE2E-109); recorded so the Jobs UI can show it. */
const providerRouteReason = (provider: RenderProviderName | undefined): RenderRouteReason => (provider === "orshot" ? "orshot_template" : "template_requires_provider");

@Injectable()
export class RenderJobsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(CreatomateTemplatesService) private readonly templates: CreatomateTemplatesService,
    @Inject(MediaDeliveryService) private readonly mediaDelivery: MediaDeliveryService,
    // VE2E-37: optional only so pre-VE2E-37 unit tests can construct the service with 4 args; both
    // Nest modules register it. Without it, a timeline with source ranges fails (never full-source fallback).
    @Inject(ClipDerivativesService) private readonly clipDerivatives?: ClipDerivativesService,
    // VE2E-110: the internal (`lyonix`) render engine. Optional so provider-only unit tests keep constructing the service unchanged.
    @Optional() @Inject(InternalRenderService) private readonly internal?: InternalRenderService,
  ) {}

  /** VE2E-47: pinned slots with `ttsProvider` backfilled from `rawTemplate` for snapshots pinned before this field existed. */
  private static snapshotSlots(snapshot: { modifications: unknown; rawTemplate?: unknown }): TemplateModificationSlotResponse[] {
    const slots = Array.isArray(snapshot.modifications) ? (snapshot.modifications as unknown as TemplateModificationSlotResponse[]) : [];
    return slotsWithTtsProvider(slots, snapshot.rawTemplate);
  }

  /** VE2E-47: TEMPLATE_TTS_CONFLICT outcome when a slot with a Creatomate TTS provider gets no LyOnix audio, unless explicitly allowed. */
  private static checkTemplateTts(slots: TemplateModificationSlotResponse[], providedKeys: Iterable<string>, allow?: boolean): { ok: false; code: "TEMPLATE_TTS_CONFLICT"; message: string; status: number; retryable: false } | null {
    if (allow) return null;
    const unfilled = unfilledTtsSlotKeys(slots, providedKeys);
    if (unfilled.length === 0) return null;
    return { ok: false, code: "TEMPLATE_TTS_CONFLICT", message: templateTtsConflictMessage(unfilled), status: 409, retryable: false };
  }

  /**
   * VE2E-37: scenes whose binding carries a source range on a video asset. Bindings without a
   * range (every timeline saved before VE2E-42, and Studio timelines without a segment plan) are
   * not returned, so they keep rendering the full asset exactly as before.
   */
  private static rangedVideoScenes(scenes: readonly SceneBindingForMapping[]): SceneBindingForMapping[] {
    return scenes.filter(
      (scene) =>
        scene.mediaKind === "video" &&
        Boolean(scene.mediaAssetVersionId) &&
        typeof scene.sourceStartMs === "number" &&
        typeof scene.sourceDurationMs === "number" &&
        scene.sourceDurationMs > 0,
    );
  }

  /**
   * VE2E-37: cut (via media-worker) or reuse a derivative for each ranged request and return the
   * scene list with those scenes re-pointed at their derivative. Any failure is returned as-is —
   * the caller must abort the render, never send the full source instead.
   */
  private async withClipDerivatives(
    projectId: string,
    userId: string,
    scenes: SceneBindingForMapping[],
    requests: ClipDerivativeRequest[],
    preparationJobId?: string,
  ): Promise<RenderOutcome<SceneBindingForMapping[]>> {
    if (requests.length === 0) return { ok: true, data: scenes };
    if (!this.clipDerivatives) {
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Media worker chưa được nối vào render — không cắt được clip", status: 503, retryable: false };
    }
    const jobId = preparationJobId;
    let failureWrite = Promise.resolve();
    const prepared = await this.clipDerivatives.prepare(projectId, userId, requests, jobId ? async (ready) => {
      void ready;
      await this.prisma.renderJob.update({ where: { id: jobId }, data: { clipsReady: { increment: 1 }, preparationLeaseUntil: new Date(Date.now() + 10 * 60_000) } });
    } : undefined, jobId ? async (sceneId, code, message) => {
      failureWrite = failureWrite.then(async () => {
        const row = await this.prisma.renderJob.findUnique({ where: { id: jobId } });
        const failed = Array.isArray(row?.clipFailures) ? row.clipFailures : [];
        await this.prisma.renderJob.update({ where: { id: jobId }, data: { clipFailures: [...failed, { sceneId, code, message }] } });
      });
      await failureWrite;
    } : undefined);
    if (!prepared.ok) return prepared;
    const bySceneId = prepared.data.derivativeBySceneId;
    return { ok: true, data: scenes.map((scene) => (bySceneId.has(scene.sceneId) ? { ...scene, mediaAssetVersionId: bySceneId.get(scene.sceneId)! } : scene)) };
  }

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
        // VE2E-47: an audio element with a template TTS provider would otherwise speak this URL as text and bill ElevenLabs itself.
        if (assignment.kind === "audio" && slot.ttsProvider) modifications[ttsProviderOverrideKey(slot.key)] = TTS_PROVIDER_DISABLED_VALUE;
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
  async submit(projectId: string, userId: string, role: "admin" | "staff", input: RenderSubmitRequest, workflowRunId?: string, queuedJobId?: string, orshotExtra?: { options: OrshotRenderOptions; durationMs: number }): Promise<RenderOutcome<RenderJobResponse>> {
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
    const slots = RenderJobsService.snapshotSlots(snapshot);
    if (!input.assignments?.length) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu assignments cho render" };
    // VE2E-47: fail closed BEFORE any signed URL / RenderJob / Creatomate call when a template TTS slot would be left to Creatomate.
    const ttsConflict = RenderJobsService.checkTemplateTts(slots, input.assignments.map((assignment) => assignment.modificationKey), input.allowTemplateTts);
    if (ttsConflict) return ttsConflict;

    const built = await this.buildModifications(projectId, userId, role, slots, input.assignments);
    if (!built.ok) return built;
    const modifications = built.data;

    // Orshot-only: fit the video length to the narration, pick format/fps/size, and estimate cost (1 credit = 1 s) BEFORE any provider call.
    const orshotPlan = account.data.provider === "orshot" ? this.planOrshotRender(orshotExtra) : null;
    if (orshotPlan && !orshotPlan.ok) return orshotPlan;
    const orshot = orshotPlan?.ok ? orshotPlan.data : null;

    // Fingerprint must be computed from the client's stable raw input, not the resolved
    // `modifications` object: video/image assignments resolve through `issueToken()`, which
    // mints a fresh signed URL (random token + expiry) on every call. Hashing that volatile
    // URL made an identical duplicate request produce a different fingerprint each time,
    // defeating the unique-constraint dedupe and double-charging Creatomate.
    const fingerprint = createHash("sha256")
      .update(stableStringify({ projectId, templateSnapshotId: input.templateSnapshotId, providerAccountId: input.providerAccountId, outputFormat: input.outputFormat ?? null, idempotencyKey: input.idempotencyKey ?? null, assignments: input.assignments }))
      .digest("hex");

    return this.createAndSubmitRenderJob(
      { projectId, templateSnapshotId: input.templateSnapshotId, providerAccountId: input.providerAccountId, userId, fingerprint, payload: modifications, workflowRunId, queuedJobId, canvas: readCreatomateCanvas(snapshot.rawTemplate), provider: account.data.provider, ...(orshot?.cost ? { cost: { amount: orshot.cost.amountUsd, currency: "USD" } } : {}) },
      (webhookUrl) => {
        const apiKey = decryptSecret(account.data.encryptedSecret);
        const base = { templateId: snapshot.externalTemplateId, modifications, webhookUrl };
        if (orshot) return submitOrshotRender(apiKey, { ...base, ...orshot.submit });
        return submitCreatomateRender(apiKey, { ...base, ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}) });
      },
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
    params: { projectId: string; templateSnapshotId: string; providerAccountId: string; userId: string; fingerprint: string; payload: unknown; workflowRunId?: string | undefined; queuedJobId?: string | undefined; canvas?: { width: number; height: number } | null | undefined; provider?: RenderProviderName; cost?: { amount: string; currency: string } },
    callProvider: (webhookUrl: string) => Promise<CreatomateRenderResult>,
  ): Promise<RenderOutcome<RenderJobResponse>> {
    let job: Awaited<ReturnType<typeof this.prisma.renderJob.create>>;
    try {
      if (params.queuedJobId) {
        // Compare-and-set: only one worker may move preparing_clips -> accepted (and so call the provider).
        const claimedQueued = await this.prisma.renderJob.updateMany({ where: { id: params.queuedJobId, status: "preparing_clips" }, data: { status: "accepted", modificationsPayload: params.payload as Prisma.InputJsonValue, preparationLeaseUntil: null } });
        if (claimedQueued.count !== 1) return { ok: false, code: "INVALID_STATE", message: "Render job không còn ở trạng thái chuẩn bị clip", status: 409 };
        const claimedRow = await this.prisma.renderJob.findUnique({ where: { id: params.queuedJobId } });
        if (!claimedRow) return { ok: false, code: "INVALID_STATE", message: "Render job không còn ở trạng thái chuẩn bị clip", status: 409 };
        job = claimedRow;
      } else {
      job = await this.prisma.renderJob.create({
        data: {
          projectId: params.projectId,
          templateSnapshotId: params.templateSnapshotId,
          providerAccountId: params.providerAccountId,
          requestFingerprint: params.fingerprint,
          webhookToken: randomBytes(24).toString("base64url"),
          status: "accepted",
          engine: params.provider ?? "creatomate",
          routeReason: providerRouteReason(params.provider),
          modificationsPayload: params.payload as unknown as Prisma.InputJsonValue,
          createdByUserId: params.userId,
          ...(params.workflowRunId ? { workflowRunId: params.workflowRunId } : {}),
        },
      });
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.renderJob.findUnique({ where: { requestFingerprint: params.fingerprint } });
        if (existing) return { ok: true, data: toJobResponse(existing) };
      }
      throw error;
    }

    // Only the request that atomically won the fingerprint race actually calls Creatomate.
    const base = process.env.PUBLIC_BASE_URL!.replace(/\/$/, "");
    const webhookUrl = `${base}/api/v1/render-webhooks/${params.provider ?? "creatomate"}/${job.webhookToken}`;
    let submitted: CreatomateRenderResult;
    try {
      submitted = await callProvider(webhookUrl);
    } catch (error) {
      const mapped = mapProviderError(error, params.provider);
      if (!(error instanceof ProviderError)) console.error("[render-jobs] render provider submit threw a non-provider error", job.id, error);
      job = await this.prisma.renderJob.update({
        where: { id: job.id },
        data: { status: "failed", lastError: { code: mapped.code, message: mapped.message } as unknown as Prisma.InputJsonValue },
      });
      return { ok: false, ...mapped };
    }
    // Creatomate has ACCEPTED the render from here on. A local persistence failure must never be reported as a
    // provider network error nor flip the job to `failed` (the render still runs and the webhook/reconcile can finish it).
    try {
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
          ...outputResolutionData(submitted),
          ...(params.canvas ? { canvasWidth: Math.round(params.canvas.width), canvasHeight: Math.round(params.canvas.height) } : {}),
          ...(params.cost ? { costAmount: new Prisma.Decimal(params.cost.amount), costCurrency: params.cost.currency } : {}),
        },
      });
    } catch (error) {
      console.error("[render-jobs] Persisting accepted Creatomate render failed; retrying with core fields only", job.id, submitted.externalJobId, error);
      // Core fields only (no optional/newer columns) so the externalJobId is never lost and webhook/reconcile can correlate.
      job = await this.prisma.renderJob.update({
        where: { id: job.id },
        data: { externalJobId: submitted.externalJobId, submittedAt: new Date(), status: "rendering" },
      });
    }
    return { ok: true, data: toJobResponse(job) };
  }

  /**
   * VE2E-07: submits a render from an approved Studio `TimelineVersion` instead of a raw
   * client-supplied assignments array. Resolves the timeline's ordered scene/audio
   * bindings into the same whitelisted `RenderAssignmentInput[]` shape `submit()` already
   * validates and delegates to it unchanged - no duplicated Creatomate-call/idempotency/
   * webhook logic, this is purely an alternate input-building path.
   *
   * VE2E-42: the Auto runner renders through this same path (after persisting its bindings as an
   * auto-approved timeline), passing `workflowRunId` so the `RenderJob` stays linked to its run.
   * Like `submit`'s own `workflowRunId`, it is never taken from an HTTP body.
   */
  async submitFromTimelineVersion(
    projectId: string,
    timelineVersionId: string,
    userId: string,
    role: "admin" | "staff",
    input: RenderSubmitFromTimelineRequest,
    workflowRunId?: string,
    queuedJobId?: string,
  ): Promise<RenderOutcome<RenderJobResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (timeline.status !== "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline chưa được duyệt", status: 409 };
    if (!timeline.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Timeline chưa chọn template" };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: timeline.templateSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    const slots = RenderJobsService.snapshotSlots(snapshot);
    const scenes = (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, projectId, scenes, { fillDefaultVideoRanges: true });
    const optionValues = (timeline.optionValues && typeof timeline.optionValues === "object" ? timeline.optionValues : {}) as Record<string, string>;
    let built = buildRenderAssignmentsFromTimeline(slots, resolved, optionValues);
    if (built.missingRequiredModificationKeys.length > 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: `Thiếu modification bắt buộc: ${built.missingRequiredModificationKeys.join(", ")}` };
    }
    // VE2E-47: refuse before any clip is cut when a template TTS slot would be left to Creatomate.
    const ttsConflict = RenderJobsService.checkTemplateTts(slots, built.filledModificationKeys, input.allowTemplateTts);
    if (ttsConflict) return ttsConflict;
    // VE2E-37: only scenes whose video actually landed in a template slot are cut. A scene keeps its
    // source audio only if the timeline explicitly set a non-zero volume for that slot (apify: never).
    const clipRequests = RenderJobsService.rangedVideoScenes(resolved)
      .filter((scene) => built.videoSlotKeyBySceneId[scene.sceneId] !== undefined)
      .map((scene): ClipDerivativeRequest => {
        const volumeKey = built.videoSlotKeyBySceneId[scene.sceneId]!.replace(/\.source$/, ".volume");
        const explicitVolume = optionValues[volumeKey];
        const keepSourceAudio = explicitVolume !== undefined && Number(explicitVolume) > 0;
        return { sceneId: scene.sceneId, parentMediaAssetVersionId: scene.mediaAssetVersionId!, startMs: scene.sourceStartMs!, durationMs: scene.sourceDurationMs!, stripAudio: !keepSourceAudio };
      });
    if (clipRequests.length > 0) {
      // Same no-charge preflight `submit` runs, but before any clip is cut.
      const account = await this.templates.usableAccount(input.providerAccountId);
      if (!account.ok) return account;
      if (!publicBaseUrlConfigured()) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };
      const withDerivatives = await this.withClipDerivatives(projectId, userId, resolved, clipRequests, queuedJobId);
      if (!withDerivatives.ok) return withDerivatives;
      built = buildRenderAssignmentsFromTimeline(slots, withDerivatives.data, optionValues);
    }
    const orshotExtra = await this.orshotExtraForTimeline(input, resolved);
    return this.submit(projectId, userId, role, {
      templateSnapshotId: timeline.templateSnapshotId,
      providerAccountId: input.providerAccountId,
      assignments: built.assignments,
      ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.allowTemplateTts ? { allowTemplateTts: true } : {}),
    }, workflowRunId, queuedJobId, orshotExtra);
  }

  /** Orshot render plan for one submit: validated options, `submit` provider args and a cost estimate (null cost = no narration to fit/estimate). */
  private planOrshotRender(extra: { options: OrshotRenderOptions; durationMs: number } | undefined): RenderOutcome<{ submit: { outputFormat?: "mp4" | "webm" | "mov" | "gif"; size?: string; videoOptions?: { duration?: number; fps?: number } }; cost: ReturnType<typeof estimateOrshotCost> | null }> {
    const options = extra?.options ?? {};
    const durationMs = extra?.durationMs ?? 0;
    const pricing = resolveOrshotPricing();
    const cost = durationMs > 0 ? estimateOrshotCost(durationMs, pricing) : null;
    if (cost?.exceedsPlanLimit) return { ok: false, code: "VALIDATION_FAILED", message: `Video dài ${cost.durationSec}s vượt giới hạn ${cost.maxVideoSeconds}s của gói Orshot (ORSHOT_MAX_VIDEO_SECONDS). Rút ngắn kịch bản hoặc nâng gói.` };
    const fit = options.fitDurationToNarration !== false && cost !== null;
    const videoOptions = { ...(fit ? { duration: cost!.durationSec } : {}), ...(options.fps ? { fps: options.fps } : {}) };
    return { ok: true, data: { submit: { ...(options.format ? { outputFormat: options.format } : {}), ...(options.size ? { size: options.size } : {}), ...(Object.keys(videoOptions).length ? { videoOptions } : {}) }, cost } };
  }

  /** Narration length of the timeline's included scenes + the sanitized Orshot options (only when the request carries any / the provider is Orshot). */
  private async orshotExtraForTimeline(input: RenderSubmitFromTimelineRequest, scenes: SceneBindingForMapping[]): Promise<{ options: OrshotRenderOptions; durationMs: number } | undefined> {
    const options = sanitizeOrshotOptions(input.orshot);
    const audioIds = [...new Set(scenes.filter((scene) => !scene.excluded).map((scene) => scene.audioVersionId).filter((id): id is string => Boolean(id)))];
    const rows = audioIds.length ? await this.prisma.audioVersion.findMany({ where: { id: { in: audioIds } }, select: { id: true, durationMs: true } }) : [];
    const byId = new Map(rows.map((row) => [row.id, row.durationMs]));
    const durationMs = narrationDurationMs(scenes.map((scene) => ({ excluded: scene.excluded, audioDurationMs: scene.audioVersionId ? byId.get(scene.audioVersionId) ?? 0 : 0 })));
    return { options: options.ok ? options.data : {}, durationMs };
  }

  /**
   * Orshot pre-render estimate for a (draft or approved) timeline: narration seconds -> credits -> USD, so the
   * operator sees the cost before spending anything. Read-only; never calls Orshot.
   */
  async estimateOrshotRender(projectId: string, timelineVersionId: string, userId: string, role: "admin" | "staff"): Promise<RenderOutcome<OrshotCostEstimateResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    const scenes = (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, projectId, scenes, { fillDefaultVideoRanges: false });
    const included = resolved.filter((scene) => !scene.excluded);
    const extra = await this.orshotExtraForTimeline({ providerAccountId: "" }, resolved);
    const estimate = estimateOrshotCost(extra?.durationMs ?? 0);
    return { ok: true, data: { ...estimate, scenesTotal: included.length, scenesWithVoice: included.filter((scene) => Boolean(scene.audioVersionId)).length } };
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
    options: { prepareClipDerivatives?: boolean; preparationJobId?: string; snapshotIdOverride?: string } = {},
  ): Promise<
    RenderOutcome<{
      templateSnapshotId: string;
      source: Record<string, unknown>;
      style: ReturnType<typeof applyDynamicStyleOverrides>;
      renderable: Awaited<ReturnType<typeof resolveSceneBindingsForMapping>>;
      totalSceneCount: number;
      /** VE2E-52: how the source was composed, for the preview response and the job record. */
      layout: { mode: "template_scaled" | "style_only"; templateSceneSlots: number; warnings: string[] };
    }>
  > {
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (!timeline.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Timeline chưa chọn template (dùng để lấy style hiển thị)" };
    // VE2E-110: a Router fallback renders a timeline pinned to an internal template with the provider snapshot linked to it.
    const styleSnapshotId = options.snapshotIdOverride ?? timeline.templateSnapshotId;
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: styleSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };

    const scenes = (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, projectId, scenes, { fillDefaultVideoRanges: true });
    const audioVersionIds = [...new Set(resolved.map((scene) => scene.audioVersionId).filter((sceneId): sceneId is string => Boolean(sceneId)))];
    const audioRows = audioVersionIds.length
      ? await this.prisma.audioVersion.findMany({ where: { id: { in: audioVersionIds } }, select: { id: true, durationMs: true } })
      : [];
    const audioDurationById = new Map(audioRows.map((row) => [row.id, row.durationMs]));
    // VE2E-32: each scene's own real ElevenLabs-alignment-derived caption segments (see
    // `caption-segmentation.ts`), so the dynamic composition can show on-screen text timed to the
    // actual narration instead of one static block for the whole scene (`dynamicScenes` loop
    // below still falls back to the static block whenever a scene has none, or a Studio override).
    // V03-03: the version the timeline pinned (a user-edited one included), see `selectSubtitlesForScenes`.
    const subtitles = await selectSubtitlesForScenes(this.prisma, resolved);

    let renderable = [...resolved]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .filter((scene) => !scene.excluded && scene.audioVersionId && scene.audioMediaAssetVersionId && scene.mediaAssetVersionId && scene.mediaKind)
      .filter((scene) => (audioDurationById.get(scene.audioVersionId!) ?? 0) > 0);
    if (renderable.length === 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Chưa có cảnh nào đủ audio + media để render — tạo voice/gán media rồi thử lại" };
    }
    // VE2E-37: the real dynamic render sends trimmed derivatives (always audio-stripped: the dynamic
    // composition has no per-video volume, so the B-roll audio would otherwise play under the
    // narration). The read-only preview never enqueues cut jobs (CR §8: preview uses the source asset).
    if (options.prepareClipDerivatives) {
      const clipRequests = RenderJobsService.rangedVideoScenes(renderable).map((scene): ClipDerivativeRequest => ({
        sceneId: scene.sceneId,
        parentMediaAssetVersionId: scene.mediaAssetVersionId!,
        startMs: scene.sourceStartMs!,
        durationMs: scene.sourceDurationMs!,
        stripAudio: true,
      }));
      // VE2E-67: still images are reframed (subject crop, one JPEG) only when REFRAME is enabled for their origin; the service drops the
      // request otherwise, so these OPTIONAL requests never change a render that does not use the feature.
      if (this.clipDerivatives) {
        for (const scene of renderable) {
          if (scene.mediaKind === "image" && scene.mediaAssetVersionId) {
            clipRequests.push({ sceneId: scene.sceneId, parentMediaAssetVersionId: scene.mediaAssetVersionId, startMs: 0, durationMs: 0, stripAudio: true, mediaKind: "image" });
          }
        }
      }
      const withDerivatives = await this.withClipDerivatives(projectId, userId, renderable, clipRequests, options.preparationJobId);
      if (!withDerivatives.ok) return withDerivatives;
      renderable = withDerivatives.data;
    }

    const dynamicScenes: DynamicSceneInput[] = [];
    for (const scene of renderable) {
      const mediaIssued = await this.mediaDelivery.issueToken(scene.mediaAssetVersionId!, userId, role, DELIVERY_TOKEN_TTL_SEC);
      if (mediaIssued === "not_configured") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };
      if (!mediaIssued || mediaIssued === "forbidden") continue;
      const audioIssued = await this.mediaDelivery.issueToken(scene.audioMediaAssetVersionId!, userId, role, DELIVERY_TOKEN_TTL_SEC);
      if (audioIssued === "not_configured") return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };
      if (!audioIssued || audioIssued === "forbidden") continue;
      // A human-typed Studio override has no real per-word timing to draw from, so it always
      // stays a single static block for the whole scene - only the un-overridden (script-derived)
      // caption uses the scene's real voice-timed segments. V03-03: an override equal to the voiced
      // narration (what Auto writes) is not a human edit and keeps the timed segments.
      const captionSegments = captionOverrideFor(scene) ? undefined : subtitles.get(scene.audioVersionId!)?.segments;
      dynamicScenes.push({
        sceneId: scene.sceneId,
        mediaUrl: mediaIssued.url,
        mediaKind: scene.mediaKind === "video" ? "video" : "image",
        ...(!options.prepareClipDerivatives && scene.mediaKind === "video" && typeof scene.sourceStartMs === "number" && typeof scene.sourceDurationMs === "number"
          ? { sourceStartMs: scene.sourceStartMs, sourceDurationMs: scene.sourceDurationMs }
          : {}),
        text: (scene.screenTextOverride ?? scene.fallbackScreenText ?? "").trim(),
        ...(captionSegments?.length ? { captionSegments } : {}),
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
    // VE2E-52: one generator for Auto, Studio final render and Studio preview - clones the pinned template's own Scene layout to exactly N scenes.
    const resolution = templateResolution(snapshot.rawTemplate) ?? { width: DYNAMIC_RENDER_WIDTH, height: DYNAMIC_RENDER_HEIGHT };
    const composed = buildDynamicCompositionWithWarnings(dynamicScenes, style, { width: resolution.width, height: resolution.height, ...(outputFormat ? { outputFormat } : {}) });
    const layout = { mode: style.layout ? ("template_scaled" as const) : ("style_only" as const), templateSceneSlots: style.layout?.scenes.length ?? 0, warnings: composed.warnings as string[] };
    return { ok: true, data: { templateSnapshotId: styleSnapshotId, source: applyCreatomateFrameRateCap(composed.source as Record<string, unknown>) as typeof composed.source, style, renderable, totalSceneCount: scenes.length, layout } };
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
    queuedJobId?: string,
  ): Promise<RenderOutcome<RenderJobResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const account = await this.templates.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (account.data.provider === "orshot") return { ok: false, code: "VALIDATION_FAILED", message: ORSHOT_NO_DYNAMIC_MESSAGE };
    if (!publicBaseUrlConfigured()) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };

    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (timeline.status !== "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline chưa được duyệt", status: 409 };

    // A converted/fallback job carries its own snapshot (the provider template linked to the internal one the timeline is pinned to).
    const queuedRow = queuedJobId ? await this.prisma.renderJob.findUnique({ where: { id: queuedJobId }, select: { templateSnapshotId: true } }) : null;
    const snapshotIdOverride = queuedRow && queuedRow.templateSnapshotId !== timeline.templateSnapshotId ? queuedRow.templateSnapshotId : undefined;
    const resolvedComposition = await this.resolveDynamicComposition(projectId, timelineVersionId, userId, role, input.outputFormat, { prepareClipDerivatives: true, ...(queuedJobId ? { preparationJobId: queuedJobId } : {}), ...(snapshotIdOverride ? { snapshotIdOverride } : {}) });
    if (!resolvedComposition.ok) return resolvedComposition;
    const { templateSnapshotId, source, style, renderable } = resolvedComposition.data;
    const { layout: templateLayout, ...styleWithoutLayout } = style;

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
          style: styleWithoutLayout,
          // VE2E-52: the layout itself is large; the pinned snapshot id + generator version identify it.
          generator: templateLayout ? `template-scaled-v1:${templateSnapshotId}` : "style-only",
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
      {
        projectId, templateSnapshotId, providerAccountId: input.providerAccountId, userId, fingerprint, payload: source, queuedJobId, canvas: readCreatomateCanvas(source),
        // Estimated from the pricing formula (w x h x fps x s / 1e8 credits) - recorded at submit like Orshot's estimate; the provider's own bill is the truth.
        cost: { amount: String(estimateProviderCostUsd("creatomate", { durationSec: renderable.reduce((sum, scene) => sum + (scene.audioDurationMs ?? 0), 0) / 1000, width: readCreatomateCanvas(source)?.width ?? 1080, height: readCreatomateCanvas(source)?.height ?? 1920, fps: Number((source as { frame_rate?: unknown }).frame_rate) || 30 })), currency: "USD" },
      },
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
  ): Promise<RenderOutcome<{ ready: boolean; source: Record<string, unknown> | null; renderableSceneCount: number; totalSceneCount: number; missingReason: string | null; layout?: { mode: "template_scaled" | "style_only"; templateSceneSlots: number; warnings: string[] } }>> {
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
        layout: resolved.data.layout,
      },
    };
  }

  /** Durable render queue shared by Studio and Auto. The HTTP path never waits for media-worker or Creatomate. */
  async enqueueTimelineRender(projectId: string, timelineVersionId: string, userId: string, role: "admin" | "staff", input: RenderSubmitFromTimelineRequest, requestedMode: "template" | "dynamic", workflowRunId?: string): Promise<RenderOutcome<RenderJobResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: timelineVersionId } });
    if (!timeline || timeline.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (timeline.status !== "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline chưa được duyệt", status: 409 };
    if (!timeline.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Timeline chưa chọn template" };
    if (input.forceEngine && role !== "admin") return { ok: false, code: "FORBIDDEN", message: "Chỉ admin được ép engine render", status: 403 };
    // VE2E-110: the internal engine's system account takes its own path (Router -> media-worker); provider accounts below are unchanged.
    const internalAccount = await this.prisma.providerAccount.findFirst({ where: { id: input.providerAccountId, deletedAt: null }, select: { provider: true } });
    if (internalAccount?.provider === "lyonix") {
      if (!this.internal) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Engine render nội bộ chưa được bật trên server này", status: 503 };
      return this.internal.enqueue({ projectId, timelineVersionId, userId, role, input, ...(workflowRunId ? { workflowRunId } : {}) });
    }
    if (input.forceEngine === "lyonix") return { ok: false, code: "VALIDATION_FAILED", message: "Mẫu của provider không có bản render nội bộ tương đương" };
    const account = await this.templates.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!publicBaseUrlConfigured()) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "PUBLIC_BASE_URL chưa cấu hình trên server", status: 503 };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: timeline.templateSnapshotId } });
    if (!snapshot || snapshot.providerAccountId !== input.providerAccountId) return { ok: false, code: "VALIDATION_FAILED", message: "Template không thuộc tài khoản render đã chọn" };
    const scenes = (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, projectId, scenes, { fillDefaultVideoRanges: true });
    let clipScenes: Array<SceneBindingForMapping & { stripAudio: boolean }>;
    // VE2E-52: the fixed-slot (modification) path only when the scene count equals the template's Scene slots;
    // any other count (fewer or more) is composed by the template-scaled generator so no scene/narration is dropped.
    const includedScenes = resolved.filter((scene) => !scene.excluded);
    const slotCount = countTemplateSceneSlots(snapshot.rawTemplate);
    const fixedSlotsOk = fixedSlotPathApplies({
      slotCount,
      includedSceneCount: includedScenes.length,
      imageSceneCount: includedScenes.filter((scene) => scene.mediaKind === "image").length,
      templateImageSlots: RenderJobsService.snapshotSlots(snapshot).filter((slot) => slot.kind === "image").length,
    });
    // Orshot has no dynamic composition: it always takes the fixed-slot template path (a count mismatch then surfaces as a missing-slot validation error, never a silent drop).
    if (account.data.provider === "orshot" && requestedMode === "dynamic") return { ok: false, code: "VALIDATION_FAILED", message: ORSHOT_NO_DYNAMIC_MESSAGE };
    const mode: "template" | "dynamic" = account.data.provider === "orshot" ? "template" : requestedMode === "template" && !fixedSlotsOk ? "dynamic" : requestedMode;
    const orshotOptions = account.data.provider === "orshot" ? sanitizeOrshotOptions(input.orshot) : null;
    if (orshotOptions && !orshotOptions.ok) return { ok: false, code: "VALIDATION_FAILED", message: orshotOptions.message };
    const orshotPayload = orshotOptions?.ok && Object.keys(orshotOptions.data).length > 0 ? orshotOptions.data : null;
    if (mode === "dynamic") {
      const composition = await this.resolveDynamicComposition(projectId, timelineVersionId, userId, role, input.outputFormat);
      if (!composition.ok) return composition;
      clipScenes = RenderJobsService.rangedVideoScenes(composition.data.renderable).map((scene) => ({ ...scene, stripAudio: true }));
    } else {
      const slots = RenderJobsService.snapshotSlots(snapshot);
      const options = (timeline.optionValues && typeof timeline.optionValues === "object" ? timeline.optionValues : {}) as Record<string, string>;
      const built = buildRenderAssignmentsFromTimeline(slots, resolved, options);
      if (built.missingRequiredModificationKeys.length) return { ok: false, code: "VALIDATION_FAILED", message: `Thiếu modification bắt buộc: ${built.missingRequiredModificationKeys.join(", ")}` };
      // VE2E-47 preflight: fail closed BEFORE the RenderJob row (and any clip cut) exists.
      const ttsConflict = RenderJobsService.checkTemplateTts(slots, built.filledModificationKeys, input.allowTemplateTts);
      if (ttsConflict) return ttsConflict;
      clipScenes = RenderJobsService.rangedVideoScenes(resolved)
        .filter((scene) => built.videoSlotKeyBySceneId[scene.sceneId] !== undefined)
        .map((scene) => {
          const explicitVolume = options[built.videoSlotKeyBySceneId[scene.sceneId]!.replace(/\.source$/, ".volume")];
          return { ...scene, stripAudio: !(explicitVolume !== undefined && Number(explicitVolume) > 0) };
        });
    }
    const clipsTotal = new Set(clipScenes.map((scene) => `${scene.mediaAssetVersionId}|${scene.sourceStartMs}|${scene.sourceDurationMs}|${scene.stripAudio}`)).size;
    // VE2E-43 P1-2: an Auto run's key is identical across manual retries, so the previous attempt's
    // FAILED job would be replayed forever. The attempt generation is the number of failed jobs this
    // run already has; a non-failed job (in flight or completed) keeps generation stable so concurrent
    // duplicate submits still dedupe onto one job and a second paid job is never created.
    let generation = 0;
    if (workflowRunId) {
      const failedJobs = await this.prisma.renderJob.count({ where: { workflowRunId, status: "failed" } });
      generation = failedJobs;
    }
    const fingerprint = `async:${createHash("sha256").update(stableStringify({ mode, projectId, timelineVersionId, providerAccountId: input.providerAccountId, outputFormat: input.outputFormat ?? null, idempotencyKey: input.idempotencyKey ?? null, ...(input.allowTemplateTts ? { allowTemplateTts: true } : {}), scenes: timeline.scenes, options: timeline.optionValues, ...(orshotPayload ? { orshot: orshotPayload } : {}), ...(Array.isArray(timeline.addedScenes) && timeline.addedScenes.length > 0 ? { addedScenes: timeline.addedScenes } : {}), ...(generation > 0 ? { generation } : {}) })).digest("hex")}`;
    const existing = await this.prisma.renderJob.findUnique({ where: { requestFingerprint: fingerprint } });
    if (existing) return { ok: true, data: toJobResponse(existing) };
    try {
      const row = await this.prisma.renderJob.create({ data: {
        projectId, templateSnapshotId: timeline.templateSnapshotId, providerAccountId: input.providerAccountId,
        requestFingerprint: fingerprint, webhookToken: randomBytes(24).toString("base64url"), status: "preparing_clips",
        engine: account.data.provider, routeReason: providerRouteReason(account.data.provider),
        modificationsPayload: { mode, timelineVersionId, outputFormat: input.outputFormat ?? null, ...(input.allowTemplateTts ? { allowTemplateTts: true } : {}), ...(orshotPayload ? { orshot: orshotPayload } : {}) },
        createdByUserId: userId, clipsTotal, clipsReady: 0,
        ...(workflowRunId ? { workflowRunId } : {}),
      } });
      return { ok: true, data: toJobResponse(row) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await this.prisma.renderJob.findUnique({ where: { requestFingerprint: fingerprint } });
        if (winner) return { ok: true, data: toJobResponse(winner) };
      }
      throw error;
    }
  }

  /** One background tick. Expired leases are reclaimed after a worker restart. */
  async processNextPreparation(): Promise<boolean> {
    const now = new Date();
    // A crash after the provider call starts cannot be safely replayed: the remote job id may
    // exist while our response was lost. Mark it explicitly unknown instead of double charging.
    const uncertain = await this.prisma.renderJob.findFirst({ where: { status: "accepted", requestFingerprint: { startsWith: "async:" }, externalJobId: null, submittedAt: null, updatedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, orderBy: { createdAt: "asc" } });
    if (uncertain) {
      await this.prisma.renderJob.updateMany({ where: { id: uncertain.id, status: "accepted", externalJobId: null }, data: { status: "failed", lastError: { code: "PROVIDER_SUBMIT_UNKNOWN", message: "Không xác định được kết quả gửi Creatomate sau khi worker khởi động lại", retryable: false } } });
      return true;
    }
    // VE2E-110: an internal render whose API process died is put back in the queue (compose is idempotent by jobKey).
    if (this.internal && (await this.internal.recoverStale(now))) return true;
    const candidate = await this.prisma.renderJob.findFirst({ where: { status: "preparing_clips", OR: [{ preparationLeaseUntil: null }, { preparationLeaseUntil: { lt: now } }] }, orderBy: { createdAt: "asc" } });
    if (!candidate) return false;
    const claimed = await this.prisma.renderJob.updateMany({ where: { id: candidate.id, status: "preparing_clips", preparationLeaseUntil: candidate.preparationLeaseUntil }, data: { preparationLeaseUntil: new Date(Date.now() + 10 * 60_000), clipsReady: 0, clipFailures: [] } });
    if (claimed.count !== 1) return true;
    if (candidate.engine === "lyonix") {
      // Internal engine: the Router decides (internal render, or convert this row to a provider job). Returns once the compose is launched.
      if (!this.internal) await this.prisma.renderJob.updateMany({ where: { id: candidate.id, status: "preparing_clips" }, data: { status: "failed", preparationLeaseUntil: null, lastError: { code: "PROVIDER_NOT_CONFIGURED", message: "Engine render nội bộ chưa được bật trên server này", retryable: false } } });
      else await this.internal.processJob(candidate);
      return true;
    }
    const payload = candidate.modificationsPayload as { mode: "template" | "dynamic"; timelineVersionId: string; outputFormat: "mp4" | "mov" | "gif" | null; allowTemplateTts?: boolean; orshot?: OrshotRenderOptions };
    try {
      const input: RenderSubmitFromTimelineRequest = { providerAccountId: candidate.providerAccountId, ...(payload.outputFormat ? { outputFormat: payload.outputFormat } : {}), ...(payload.allowTemplateTts ? { allowTemplateTts: true } : {}), ...(payload.orshot ? { orshot: payload.orshot } : {}) };
      const actor = await this.prisma.user.findUnique({ where: { id: candidate.createdByUserId }, select: { role: true } });
      if (!actor) throw new Error("Render creator no longer exists");
      const role = actor.role === "admin" ? "admin" : "staff";
      const outcome = payload.mode === "dynamic"
        ? await this.submitDynamicFromTimeline(candidate.projectId, payload.timelineVersionId, candidate.createdByUserId, role, input, candidate.id)
        : await this.submitFromTimelineVersion(candidate.projectId, payload.timelineVersionId, candidate.createdByUserId, role, input, candidate.workflowRunId ?? undefined, candidate.id);
      if (!outcome.ok) {
        const current = await this.prisma.renderJob.findUnique({ where: { id: candidate.id } });
        const clipFailures = Array.isArray(current?.clipFailures) && current.clipFailures.length ? current.clipFailures as Prisma.InputJsonValue : [{ sceneId: "", code: outcome.code, message: outcome.message }];
        // Compare-and-set: a job another worker already moved past preparing_clips (accepted/queued/
        // rendering/completed, with or without externalJobId) is never overwritten from here.
        await this.prisma.renderJob.updateMany({ where: { id: candidate.id, status: "preparing_clips" }, data: { status: "failed", preparationLeaseUntil: null, lastError: { code: outcome.code, message: outcome.message, retryable: outcome.retryable ?? false }, clipFailures } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Render preparation failed";
      // Same guard: an exception after the provider call succeeded must not fail a submitted job
      // (an `accepted` job with unknown outcome is settled by the PROVIDER_SUBMIT_UNKNOWN sweep instead).
      await this.prisma.renderJob.updateMany({ where: { id: candidate.id, status: "preparing_clips" }, data: { status: "failed", preparationLeaseUntil: null, lastError: { code: "MEDIA_PREPARE_FAILED", message, retryable: true }, clipFailures: [{ sceneId: "", code: "MEDIA_PREPARE_FAILED", message }] } });
    }
    return true;
  }

  /**
   * VE2E-110: resolves the stored output (video or cover) of a completed INTERNAL render for streaming. Access = project access; the file is
   * under `working/renders` (7-day TTL), so an expired/swept file is a 404 with a clear message, never a broken link served from elsewhere.
   */
  async resolveInternalOutput(id: string, userId: string, role: "admin" | "staff", kind: "video" | "thumbnail"): Promise<RenderOutcome<{ absolutePath: string; mimeType: string; bytes: number; fileName: string }>> {
    const row = await this.prisma.renderJob.findUnique({ where: { id } });
    if (!row || !(await this.assertProjectAccess(row.projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy render job", status: 404 };
    const relativePath = kind === "video" ? row.outputRelativePath : row.thumbnailRelativePath;
    if (row.engine !== "lyonix" || row.status !== "completed" || !relativePath) return { ok: false, code: "NOT_FOUND", message: "Render này chưa có file thành phẩm", status: 404 };
    if (!isSafeRelativePath(relativePath) || !relativePath.startsWith("working/renders/")) return { ok: false, code: "NOT_FOUND", message: "Đường dẫn thành phẩm không hợp lệ", status: 404 };
    const absolutePath = join(mediaRoot(), relativePath);
    const info = await stat(absolutePath).catch(() => null);
    if (!info?.isFile()) return { ok: false, code: "NOT_FOUND", message: "File thành phẩm đã hết hạn (lưu 7 ngày) hoặc bị xóa", status: 404 };
    return { ok: true, data: { absolutePath, mimeType: kind === "video" ? "video/mp4" : "image/jpeg", bytes: info.size, fileName: `lyonix-${id}.${kind === "video" ? "mp4" : "jpg"}` } };
  }

  async get(id: string, userId: string, role: "admin" | "staff"): Promise<RenderOutcome<RenderJobResponse>> {
    const row = await this.prisma.renderJob.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy render job", status: 404 };
    if (!(await this.assertProjectAccess(row.projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy render job", status: 404 };
    if (!isTerminalRenderStatus(row.status as RenderJobStatus) && row.externalJobId) {
      const reconciled = await this.reconcileOne(row.id);
      if (reconciled.ok) return { ok: true, data: await this.withQueueState(reconciled.data, row) };
    }
    return { ok: true, data: await this.withQueueState(toJobResponse(row), row) };
  }

  private queueStatusService: QueueStatusService | null = null;
  /** VE2E-62: adds queueKind/queuePosition/queuedAt/startedAt (derived from rows, see QueueStatusService); terminal jobs skip the queue queries. */
  private async withQueueState(response: RenderJobResponse, row: { id: string; status: string; createdAt: Date; preparationLeaseUntil?: Date | null; submittedAt?: Date | null }): Promise<RenderJobResponse> {
    if (isTerminalRenderStatus(row.status as RenderJobStatus)) {
      return { ...response, queueKind: null, queuePosition: null, queuedAt: row.createdAt.toISOString(), startedAt: row.submittedAt?.toISOString() ?? null };
    }
    const state = await (this.queueStatusService ??= new QueueStatusService(this.prisma)).renderQueueState(row);
    return { ...response, ...state };
  }

  /** Applies the monotonic status guard and persists a Creatomate-reported result. Never lets a terminal state regress. */
  private async applyStatus(jobId: string, current: RenderJobStatus, incoming: { status: RenderJobStatus; url?: string | null; progress?: number | null; errorMessage?: string | null; renderDurationMs?: number | null; snapshotUrl?: string | null; renderScale?: number | null; width?: number | null; height?: number | null }) {
    const nextStatus = nextRenderJobStatus(current, incoming.status);
    if (!nextStatus) return null; // stale/out-of-order/duplicate — no-op, current row already reflects the latest applied state.
    const data: Prisma.RenderJobUpdateInput = { status: nextStatus };
    if (incoming.progress !== undefined && incoming.progress !== null) data.progress = incoming.progress;
    // VE2E-19: Creatomate can report a preview frame before the render is fully complete — capture it whenever present, not only at completion.
    if (incoming.snapshotUrl) data.snapshotUrl = incoming.snapshotUrl;
    Object.assign(data, outputResolutionData(incoming));
    if (nextStatus === "completed") {
      data.resultUrl = incoming.url ?? null;
      data.completedAt = new Date();
      if (incoming.renderDurationMs != null) data.renderDurationMs = incoming.renderDurationMs;
    }
    if (nextStatus === "failed") {
      data.completedAt = new Date();
      // VE2E-47: Creatomate-side TTS/quota failures get a real code + the real message, not "submit unknown".
      data.lastError = classifyCreatomateRenderError(incoming.errorMessage) as unknown as Prisma.InputJsonValue;
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
      const remote = await (account.provider === "orshot" ? getOrshotRender : getCreatomateRender)(decryptSecret(account.encryptedSecret), row.externalJobId);
      const updated = await this.applyStatus(row.id, row.status as RenderJobStatus, {
        status: normalizeCreatomateStatus(remote.status),
        url: remote.url,
        progress: remote.progress,
        errorMessage: remote.errorMessage,
        renderDurationMs: remote.renderDurationMs,
        snapshotUrl: remote.snapshotUrl,
        renderScale: remote.renderScale,
        width: remote.width,
        height: remote.height,
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
  /**
   * Orshot webhook: polling `GET /studio/render-jobs/:id` is Orshot's documented source of truth, so the
   * callback body is never trusted — it only (token-authenticated) triggers an immediate reconcile.
   */
  async handleOrshotWebhook(token: string): Promise<RenderOutcome<{ received: true }>> {
    const job = await this.prisma.renderJob.findUnique({ where: { webhookToken: token } });
    if (!job) return { ok: false, code: "WEBHOOK_INVALID", message: "Webhook token không hợp lệ", status: 404 };
    await this.reconcileOne(job.id);
    return { ok: true, data: { received: true } };
  }

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
            renderScale: typeof record.render_scale === "number" ? record.render_scale : null,
            width: typeof record.width === "number" ? record.width : null,
            height: typeof record.height === "number" ? record.height : null,
          };
      const updated = await this.applyStatus(job.id, job.status as RenderJobStatus, outcome);
      await this.prisma.renderWebhookEvent.updateMany({ where: { renderJobId: job.id, eventFingerprint }, data: { appliedStatus: updated?.status ?? null } });
    }
    return { ok: true, data: { received: true } };
  }
}
