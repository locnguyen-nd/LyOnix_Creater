import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@lyonix/db";
import {
  DEFAULT_ROUTER_CONFIG,
  estimateProviderCostUsd,
  routeRender,
  type CharacterAlignment,
  type RouteDecision,
  type RouterConfig,
  type RouterTemplate,
} from "@lyonix/domain";
import type { ErrorCode, RenderEngine, RenderJobResponse, RenderRouteReason, RenderSubmitFromTimelineRequest, TimelineSceneBindingResponse } from "@lyonix/contracts";
import { buildComposeJobKey, isComposeInputError, MediaJobClientError, type ComposeVideoOptions, type VideoComposeJobInput, type VideoComposeProgress, type VideoComposeResult } from "@lyonix/media-jobs";
import { recipeRegistry, type RenderRecipe } from "@lyonix/render-recipes";
import { buildComposePlan, type PlanAsset, type PlanCaptionSource } from "./compose-plan.js";
import { ClipDerivativesService, type ClipDerivativeRequest } from "./clip-derivatives.service.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { MediaJobsGateway, type VideoComposer } from "./media-jobs.gateway.js";
import { PrismaService } from "./prisma.service.js";
import { resolveSceneBindingsForMapping, type SceneBindingForMapping } from "./timeline-render-mapping.js";
import { selectSubtitlesForScenes } from "./subtitle-selection.js";
import { StageRecorder } from "./stage-timing.js";
import { checkTemplateRenderable, usableFallbackSnapshotIds, type ReadinessDeps } from "./template-readiness.js";

/**
 * VE2E-110: orchestration of the internal `lyonix` render engine for one RenderJob.
 *
 *   enqueue (Studio/Auto)  -> RenderJob{engine=lyonix, preparing_clips}
 *   processJob             -> Render Router (domain) decides: internal engine, or a provider (canary_holdout / local_unhealthy / overflow / forced)
 *     internal             -> cut/reframe clips (clip.prepare) -> RenderPlan -> `video.compose` on lyonix.render (result comes back on the
 *                             reply queue, no polling) -> QC passed => completed (+ cost, duration, sha256, profile) / QC or technical failure
 *                             => ONE fallback job on Creatomate (`fallbackOfJobId`, `fallback_after_error`), unless the error is the input's
 *                             own fault or the spend ceiling is reached (`budget_exhausted`: nothing is sent to a provider).
 *     provider             -> the job row is converted in place (snapshot/account/engine/reason) and the existing Creatomate path runs it.
 * Creatomate/Orshot behaviour is not changed: provider-owned templates never enter this service.
 */

export const FALLBACK_REASONS: readonly RenderRouteReason[] = ["canary_holdout", "overflow", "local_unhealthy", "fallback_after_error"];

/** Router configuration from env (overflow OFF by default, fallback ceiling 50 USD/day). */
export function loadRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const num = (name: string, fallback: number): number => {
    const value = Number(env[name]);
    return env[name]?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const monthly = env.RENDER_FALLBACK_MONTHLY_USD?.trim();
  return {
    overflowEnabled: /^(1|true|yes)$/i.test(env.RENDER_OVERFLOW_ENABLED?.trim() ?? ""),
    overflowSlaMs: num("RENDER_OVERFLOW_SLA_MS", DEFAULT_ROUTER_CONFIG.overflowSlaMs),
    fallbackDailyUsd: num("RENDER_FALLBACK_DAILY_USD", DEFAULT_ROUTER_CONFIG.fallbackDailyUsd),
    fallbackMonthlyUsd: monthly && Number.isFinite(Number(monthly)) && Number(monthly) >= 0 ? Number(monthly) : null,
  };
}

/** USD per CPU-hour of the machine rendering internally (default 0 = unknown/free); cost = CPU-seconds / 3600 x this. */
export const localUsdPerCpuHour = (env: NodeJS.ProcessEnv = process.env): number => {
  const value = Number(env.RENDER_LOCAL_USD_PER_CPU_HOUR);
  return env.RENDER_LOCAL_USD_PER_CPU_HOUR?.trim() && Number.isFinite(value) && value >= 0 ? value : 0;
};

const DEFAULT_ESTIMATED_RENDER_MS = 120_000;
const LEASE_MS = 5 * 60_000;
const PROGRESS_WRITE_EVERY_MS = 2_000;

type JobRow = NonNullable<Awaited<ReturnType<PrismaService["renderJob"]["findUnique"]>>>;

/**
 * One finished compose -> `render_compose` (wall clock, API side), `render_transport` (wall minus the worker's own render time:
 * RabbitMQ wait + delivery) and one `ffmpeg_<stage>` per media-worker stage (laid end to end from the worker's start).
 */
function recordComposeStages(timings: StageRecorder | undefined, startedAt: number, endedAt: number, result: Extract<VideoComposeResult, { ok: true }>): void {
  if (!timings) return;
  const workerMs = Math.max(0, Math.min(result.metrics.renderMs, endedAt - startedAt));
  const transportMs = endedAt - startedAt - workerMs;
  timings.add("render_compose", startedAt, endedAt, {
    provider: "lyonix",
    cache: result.reused ? "hit" : "miss",
    detail: { ffmpegMs: result.metrics.renderMs, cpuSeconds: result.metrics.cpuSeconds, preset: result.metrics.x264Preset, threads: result.metrics.x264Threads, frames: Math.round((result.output.durationMs / 1000) * result.output.fps) },
  });
  timings.add("render_transport", startedAt, startedAt + transportMs, { provider: "lyonix" });
  let cursor = startedAt + transportMs;
  for (const [stage, ms] of Object.entries(result.metrics.stagesMs ?? {})) {
    if (typeof ms !== "number" || ms < 0) continue;
    timings.add(`ffmpeg_${stage}`, cursor, cursor + ms, { provider: "lyonix" });
    cursor += ms;
  }
}
type Outcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };
/** Internal-only: context loading reports codes that are a superset of the REST ones (RECIPE_NOT_FOUND ...); they end up in `lastError`, never in an HTTP envelope. */
type ContextOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

type JobPayload = { mode: "lyonix" | "dynamic" | "template"; timelineVersionId: string; outputFormat?: "mp4" | "mov" | "gif" | null; forceEngine?: RenderEngine | null; compose?: { jobKey: string; recipe: { id: string; version: number } } };

type Context = {
  timeline: { id: string; projectId: string; scenes: unknown; optionValues: unknown; templateSnapshotId: string | null };
  snapshot: { id: string; engine: string; rolloutPercent: number; fallbackSnapshotIds: unknown; rawTemplate: unknown; providerAccountId: string };
  recipe: RenderRecipe;
  scenes: SceneBindingForMapping[];
  optionValues: Record<string, string>;
  estimatedDurationSec: number;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((k) => record[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const isRenderable = (scene: SceneBindingForMapping): boolean => !scene.excluded && Boolean(scene.audioVersionId && scene.audioMediaAssetVersionId && scene.mediaAssetVersionId && scene.mediaKind) && (scene.audioDurationMs ?? 0) > 0;

/**
 * VE2E-157: what a scene still kept in the video lacks for the internal engine ("Cảnh 3 (scene_3): thiếu media, thiếu giọng đọc"), in
 * video order. The engine would otherwise drop such a scene (and its narration) silently from the MP4; empty = every kept scene renders.
 */
export function unrenderableScenes(scenes: readonly SceneBindingForMapping[]): string[] {
  const kept = [...scenes].filter((scene) => !scene.excluded).sort((a, b) => a.orderIndex - b.orderIndex);
  const lines: string[] = [];
  kept.forEach((scene, index) => {
    const missing: string[] = [];
    if (!scene.mediaAssetVersionId || !scene.mediaKind) missing.push("thiếu media");
    if (!scene.audioVersionId || !scene.audioMediaAssetVersionId || !((scene.audioDurationMs ?? 0) > 0)) missing.push("thiếu giọng đọc");
    if (missing.length > 0) lines.push(`Cảnh ${index + 1} (${scene.sceneId}): ${missing.join(", ")}`);
  });
  return lines;
}

@Injectable()
export class InternalRenderService {
  private readonly inflight = new Map<string, Promise<void>>();
  /** Stage timings of the render jobs this process is handling (persisted as the run's `render_timings` StepRun when the job ends here). */
  private readonly renderTimings = new Map<string, StageRecorder>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CreatomateTemplatesService) private readonly templates: CreatomateTemplatesService,
    @Optional() @Inject(ClipDerivativesService) private readonly clipDerivatives?: ClipDerivativesService,
    @Optional() @Inject(MediaJobsGateway) private readonly composer?: VideoComposer,
  ) {}

  /** Router limits and the cost rate; plain fields (not constructor parameters) so Nest DI has nothing to resolve and tests can set them. */
  routerConfig: RouterConfig = loadRouterConfig();
  cpuHourUsd: number = localUsdPerCpuHour();

  /** Test hook / graceful shutdown: resolves when every in-flight compose has settled. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()]);
  }

  // ---------------------------------------------------------------------------------------------------------------- enqueue

  /** Creates (or dedupes onto) the RenderJob of an internal render. The caller has already checked project access and that the account is the system account. */
  async enqueue(args: {
    projectId: string;
    timelineVersionId: string;
    userId: string;
    role: "admin" | "staff";
    input: RenderSubmitFromTimelineRequest;
    workflowRunId?: string | undefined;
  }): Promise<Outcome<RenderJobResponse>> {
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: args.timelineVersionId } });
    if (!timeline || timeline.projectId !== args.projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (timeline.status !== "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline chưa được duyệt", status: 409 };
    if (!timeline.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Timeline chưa chọn template" };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: timeline.templateSnapshotId } });
    if (!snapshot || snapshot.providerAccountId !== args.input.providerAccountId || snapshot.engine !== "lyonix") {
      return { ok: false, code: "VALIDATION_FAILED", message: "Template không thuộc engine nội bộ đã chọn" };
    }
    if (args.input.forceEngine && args.role !== "admin") return { ok: false, code: "FORBIDDEN", message: "Chỉ admin được ép engine render", status: 403 };
    // V04-01: same readiness rule as applying the template (Studio) and the Auto preflight, before any RenderJob exists - a template at
    // rollout 0 % or without a way to render is refused here instead of failing later. An admin forcing an engine is the explicit
    // override of the rollout (A/B); the Router then still never calls a provider without a configured fallback.
    if (!args.input.forceEngine) {
      const renderable = await checkTemplateRenderable(this.readinessDeps(), { snapshot, providerAccountId: args.input.providerAccountId, checkEngine: true });
      if (!renderable.ok) return { ok: false, code: renderable.code, message: renderable.message, status: renderable.status };
    }

    const scenes = (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, args.projectId, scenes, { fillDefaultVideoRanges: true });
    if (!resolved.some(isRenderable)) return { ok: false, code: "VALIDATION_FAILED", message: "Chưa có cảnh nào đủ audio + media để render — tạo voice/gán media rồi thử lại" };
    // VE2E-157: never an MP4 with a scene silently missing - refused before any RenderJob, naming each scene and what it lacks.
    const incomplete = unrenderableScenes(resolved);
    if (incomplete.length > 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: `Không render được vì cảnh chưa đủ media/giọng đọc: ${incomplete.join("; ")}. Gán media, tạo giọng đọc hoặc bỏ cảnh đó khỏi video rồi thử lại.` };
    }

    // An Auto run's key repeats across manual retries: the attempt generation (failed jobs so far) keeps a failed attempt from being replayed forever.
    const generation = args.workflowRunId ? await this.prisma.renderJob.count({ where: { workflowRunId: args.workflowRunId, status: "failed", fallbackOfJobId: null } }) : 0;
    const fingerprint = `async:${createHash("sha256")
      .update(stableStringify({ mode: "lyonix", projectId: args.projectId, timelineVersionId: args.timelineVersionId, providerAccountId: args.input.providerAccountId, forceEngine: args.input.forceEngine ?? null, idempotencyKey: args.input.idempotencyKey ?? null, scenes: timeline.scenes, options: timeline.optionValues, ...(generation > 0 ? { generation } : {}) }))
      .digest("hex")}`;
    const existing = await this.prisma.renderJob.findUnique({ where: { requestFingerprint: fingerprint } });
    if (existing) return { ok: true, data: this.toResponse(existing) };
    const payload: JobPayload = { mode: "lyonix", timelineVersionId: args.timelineVersionId, outputFormat: null, forceEngine: args.input.forceEngine ?? null };
    try {
      const row = await this.prisma.renderJob.create({
        data: {
          projectId: args.projectId,
          templateSnapshotId: snapshot.id,
          providerAccountId: args.input.providerAccountId,
          requestFingerprint: fingerprint,
          webhookToken: randomBytes(24).toString("base64url"),
          status: "preparing_clips",
          engine: "lyonix",
          modificationsPayload: payload as unknown as Prisma.InputJsonValue,
          createdByUserId: args.userId,
          clipsTotal: this.countClipRequests(resolved.filter(isRenderable)),
          clipsReady: 0,
          ...(args.workflowRunId ? { workflowRunId: args.workflowRunId } : {}),
        },
      });
      return { ok: true, data: this.toResponse(row) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await this.prisma.renderJob.findUnique({ where: { requestFingerprint: fingerprint } });
        if (winner) return { ok: true, data: this.toResponse(winner) };
      }
      throw error;
    }
  }

  private countClipRequests(scenes: SceneBindingForMapping[]): number {
    return this.clipRequests(scenes).length;
  }

  /** Ranged videos are cut; still images are reframed when the feature is on for their origin (the service drops the request otherwise). */
  private clipRequests(scenes: SceneBindingForMapping[]): ClipDerivativeRequest[] {
    const requests: ClipDerivativeRequest[] = scenes
      .filter((scene) => scene.mediaKind === "video" && scene.mediaAssetVersionId && typeof scene.sourceStartMs === "number" && typeof scene.sourceDurationMs === "number" && scene.sourceDurationMs > 0)
      .map((scene) => ({ sceneId: scene.sceneId, parentMediaAssetVersionId: scene.mediaAssetVersionId!, startMs: scene.sourceStartMs!, durationMs: scene.sourceDurationMs!, stripAudio: true }));
    if (this.clipDerivatives) {
      for (const scene of scenes) {
        if (scene.mediaKind === "image" && scene.mediaAssetVersionId) requests.push({ sceneId: scene.sceneId, parentMediaAssetVersionId: scene.mediaAssetVersionId, startMs: 0, durationMs: 0, stripAudio: true, mediaKind: "image" });
      }
    }
    return requests;
  }

  // ---------------------------------------------------------------------------------------------------------------- process

  /**
   * One background tick for a claimed `preparing_clips` job of the internal engine. Returns after the compose has been LAUNCHED (it keeps
   * running detached, tracked in `inflight`; progress and the final result are written by the callbacks), so one long render never blocks
   * the preparation of other jobs.
   */
  async processJob(job: JobRow): Promise<void> {
    const timings = new StageRecorder("render", job.id);
    this.renderTimings.set(job.id, timings);
    // From the RenderJob row (written by the run's submit_render / Studio) to this worker claiming it.
    timings.add("render_queue_wait", job.createdAt.getTime(), Date.now(), { provider: "lyonix" });
    try {
      const payload = job.modificationsPayload as unknown as JobPayload;
      const context = await this.loadContext(job, payload);
      if (!context.ok) return await this.failJob(job, context.code, context.message, null);
      const decision = await this.decide(job, payload, context.data, null);
      await this.applyDecision(job, payload, context.data, decision);
    } finally {
      // A launched compose finishes (and persists the timings) on its own; anything else ends here.
      if (!this.inflight.has(job.id)) await this.persistTimings(job);
    }
  }

  /** Writes the job's stage timings as the `render_timings` StepRun of its Auto run (Studio renders only log them). Best-effort. */
  private async persistTimings(job: JobRow): Promise<void> {
    const timings = this.renderTimings.get(job.id);
    if (!timings) return;
    this.renderTimings.delete(job.id);
    if (!job.workflowRunId) return;
    try {
      const run = await this.prisma.workflowRun.findUnique({ where: { id: job.workflowRunId }, select: { attempts: true } });
      if (!run) return;
      const first = timings.events[0];
      const startedAt = first ? new Date(first.startedAt) : new Date();
      const endedAt = new Date();
      const outputRef = { renderJobId: job.id, events: timings.events } as unknown as Prisma.InputJsonValue;
      await this.prisma.stepRun.upsert({
        where: { workflowRunId_stepKey_attempt: { workflowRunId: job.workflowRunId, stepKey: "render_timings", attempt: run.attempts } },
        create: { workflowRunId: job.workflowRunId, stepKey: "render_timings", attempt: run.attempts, status: "succeeded", startedAt, endedAt, outputRef },
        update: { status: "succeeded", startedAt, endedAt, outputRef },
      });
    } catch {
      // timing must never fail a render
    }
  }

  private async loadContext(job: JobRow, payload: JobPayload): Promise<ContextOutcome<Context>> {
    const timeline = await this.prisma.timelineVersion.findUnique({ where: { id: payload.timelineVersionId } });
    if (!timeline || timeline.projectId !== job.projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version" };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: job.templateSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot" };
    const raw = snapshot.rawTemplate as { id?: unknown; version?: unknown } | null;
    const recipe = typeof raw?.id === "string" && typeof raw.version === "number" ? recipeRegistry.get(raw.id, raw.version) : null;
    if (!recipe) return { ok: false, code: "RECIPE_NOT_FOUND", message: "Recipe của mẫu nội bộ không có trong bản phát hành này" };
    const scenes = await resolveSceneBindingsForMapping(this.prisma, job.projectId, (Array.isArray(timeline.scenes) ? timeline.scenes : []) as TimelineSceneBindingResponse[], { fillDefaultVideoRanges: true });
    const renderable = scenes.filter(isRenderable);
    if (renderable.length === 0) return { ok: false, code: "VALIDATION_FAILED", message: "Chưa có cảnh nào đủ audio + media để render" };
    const optionValues = (timeline.optionValues && typeof timeline.optionValues === "object" ? timeline.optionValues : {}) as Record<string, string>;
    const estimatedDurationSec = renderable.reduce((sum, scene) => sum + (scene.audioDurationMs ?? 0), 0) / 1000;
    return { ok: true, data: { timeline, snapshot, recipe, scenes, optionValues, estimatedDurationSec } };
  }

  // ---------------------------------------------------------------------------------------------------------------- routing

  /** Spend of Router fallbacks so far (finished jobs' recorded cost + an estimate for those still running), UTC day and month. */
  private async spend(now = new Date(), inflightCostUsd = 0): Promise<{ todayUsd: number; monthUsd: number }> {
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const where = (since: Date): Prisma.RenderJobWhereInput => ({ engine: { in: ["creatomate", "orshot"] }, routeReason: { in: [...FALLBACK_REASONS] }, createdAt: { gte: since } });
    const sum = async (since: Date): Promise<number> => {
      const done = await this.prisma.renderJob.aggregate({ where: where(since), _sum: { costAmount: true } });
      const running = await this.prisma.renderJob.count({ where: { ...where(since), costAmount: null, status: { notIn: ["failed", "cancelled"] } } });
      return Number(done._sum.costAmount ?? 0) + running * inflightCostUsd;
    };
    return { todayUsd: await sum(startOfDay), monthUsd: await sum(startOfMonth) };
  }

  private async localState(): Promise<{ healthy: boolean; estimatedWaitMs: number }> {
    const status = this.composer ? await this.composer.renderQueueStatus() : null;
    if (!status || status.consumers < 1) return { healthy: false, estimatedWaitMs: 0 };
    const recent = await this.prisma.renderJob.findMany({ where: { engine: "lyonix", status: "completed", renderDurationMs: { not: null } }, orderBy: { completedAt: "desc" }, take: 20, select: { renderDurationMs: true } });
    const durations = recent.map((row) => row.renderDurationMs!).sort((a, b) => a - b);
    const median = durations.length ? durations[Math.floor(durations.length / 2)]! : DEFAULT_ESTIMATED_RENDER_MS;
    const running = await this.prisma.renderJob.count({ where: { engine: "lyonix", status: { in: ["rendering", "verifying"] } } });
    return { healthy: true, estimatedWaitMs: Math.round(((status.queued + running) * median) / Math.max(status.consumers, 1)) };
  }

  private readinessDeps(): ReadinessDeps {
    return { prisma: this.prisma, usableAccount: (id) => this.templates.usableAccount(id), ...(this.composer ? { renderQueueStatus: () => this.composer!.renderQueueStatus() } : {}) };
  }

  /** Provider (Creatomate) snapshots usable as fallback for this template, in the admin's/auto-linked order (same list the readiness check counts). */
  private async fallbackSnapshots(snapshot: Context["snapshot"]): Promise<RouterTemplate["fallbackSnapshots"]> {
    // v1 falls back through the dynamic Creatomate composition only (Orshot has no dynamic composition).
    return (await usableFallbackSnapshotIds(this.readinessDeps(), snapshot)).map((snapshotId) => ({ snapshotId, engine: "creatomate" as const }));
  }

  private async decide(job: JobRow, payload: JobPayload, context: Context, afterError: { code: string } | null): Promise<RouteDecision> {
    const fallbackSnapshots = await this.fallbackSnapshots(context.snapshot);
    const fallbackCostUsd = estimateProviderCostUsd("creatomate", { durationSec: context.estimatedDurationSec, width: 1080, height: 1920, fps: 60 });
    const template: RouterTemplate = { snapshotId: context.snapshot.id, engine: "lyonix", providerOnly: false, rolloutPercent: context.snapshot.rolloutPercent, fallbackSnapshots };
    return routeRender(
      {
        jobKey: job.requestFingerprint,
        forcedEngine: payload.forceEngine ?? null,
        template,
        local: await this.localState(),
        spend: await this.spend(new Date(), fallbackCostUsd),
        fallbackCostUsd,
        afterError: afterError ? { code: afterError.code, isInputError: isComposeInputError(afterError.code), alreadyFellBack: job.fallbackOfJobId !== null && job.fallbackOfJobId !== undefined } : null,
      },
      this.routerConfig,
    );
  }

  private async applyDecision(job: JobRow, payload: JobPayload, context: Context, decision: RouteDecision): Promise<void> {
    if (decision.kind === "fail") {
      const code = decision.code === "NO_FALLBACK_TEMPLATE" ? "PROVIDER_NOT_CONFIGURED" : decision.code;
      return this.failJob(job, code, decision.message, null);
    }
    if (decision.kind === "blocked") return this.failJob(job, "RENDER_BUDGET_EXHAUSTED", decision.detail, "budget_exhausted");
    if (decision.engine !== "lyonix") return this.convertToProvider(job, payload, decision.snapshotId, decision.reason);
    await this.startInternal(job, payload, context, decision.reason);
  }

  /** The Router picked a provider before any internal attempt: convert the queued row in place; the existing Creatomate path runs it on the next tick. */
  private async convertToProvider(job: JobRow, payload: JobPayload, snapshotId: string, reason: RenderRouteReason): Promise<void> {
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: snapshotId }, select: { providerAccountId: true } });
    if (!snapshot) return this.failJob(job, "NOT_FOUND", "Không tìm thấy mẫu provider dự phòng", reason);
    await this.prisma.renderJob.updateMany({
      where: { id: job.id, status: "preparing_clips" },
      data: {
        templateSnapshotId: snapshotId,
        providerAccountId: snapshot.providerAccountId,
        engine: "creatomate",
        routeReason: reason,
        modificationsPayload: { ...payload, mode: "dynamic" } as unknown as Prisma.InputJsonValue,
        preparationLeaseUntil: null,
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------------- internal render

  private async startInternal(job: JobRow, payload: JobPayload, context: Context, reason: RenderRouteReason): Promise<void> {
    const renderable = context.scenes.filter(isRenderable);
    const timings = this.renderTimings.get(job.id);
    const prepareStartedAt = Date.now();
    const prepared = await this.prepareClips(job, renderable);
    timings?.add("render_prepare_clips", prepareStartedAt, Date.now(), {
      provider: "lyonix",
      ok: prepared.ok,
      ...(prepared.ok ? { cache: prepared.requested === 0 ? "n/a" : prepared.fromRegistry === prepared.requested ? "hit" : "miss", detail: { requested: prepared.requested, fromRegistry: prepared.fromRegistry, cutByWorker: prepared.requested - prepared.fromRegistry } } : { code: prepared.code }),
    });
    if (!prepared.ok) return this.failJob(job, prepared.code, prepared.message, reason, prepared.retryable);
    const planStartedAt = Date.now();

    const scenes = prepared.scenes;
    const assetIds = [...new Set(scenes.flatMap((scene) => [scene.mediaAssetVersionId, scene.audioMediaAssetVersionId]).filter((id): id is string => Boolean(id)))];
    const assetRows = await this.prisma.mediaAssetVersion.findMany({ where: { id: { in: assetIds }, projectId: job.projectId, deletedAt: null }, select: { id: true, relativePath: true, checksumSha256: true } });
    const assets = new Map<string, PlanAsset>(assetRows.map((row) => [row.id, { relativePath: row.relativePath, checksumSha256: row.checksumSha256 }]));
    const captions = await this.captionSources(scenes);
    const built = buildComposePlan({ scenes, assets, preparedMediaIds: new Set(prepared.derivativeIds), captions, optionValues: context.optionValues, recipe: context.recipe, templateSnapshotId: context.snapshot.id });
    if (!built.ok) return this.failJob(job, built.code === "ASSET_MISSING" ? "SOURCE_NOT_FOUND" : "VALIDATION_FAILED", built.message, reason);

    const recipeRef = { id: context.recipe.id, version: context.recipe.version };
    const composeJob: VideoComposeJobInput = { jobKey: buildComposeJobKey({ recipe: recipeRef, plan: built.plan }), recipe: recipeRef, plan: built.plan };
    timings?.add("render_build_plan", planStartedAt, Date.now(), { provider: "lyonix", detail: { scenes: built.plan.scenes.length, totalFrames: built.plan.totalFrames } });
    const updated = await this.prisma.renderJob.updateMany({
      where: { id: job.id, status: "preparing_clips" },
      data: {
        status: "rendering",
        engine: "lyonix",
        routeReason: reason,
        progress: 0,
        submittedAt: new Date(),
        preparationLeaseUntil: new Date(Date.now() + LEASE_MS),
        canvasWidth: 1080,
        canvasHeight: 1920,
        modificationsPayload: { ...payload, compose: { jobKey: composeJob.jobKey, recipe: recipeRef } } as unknown as Prisma.InputJsonValue,
      },
    });
    if (updated.count !== 1) return; // another worker took it
    const running = this.runCompose(job, composeJob);
    this.inflight.set(job.id, running);
    void running.finally(() => this.inflight.delete(job.id));
  }

  /** Cuts/reframes the clips this render needs and re-points the scenes at the derivatives. Failures abort the render (never the full source). */
  private async prepareClips(job: JobRow, renderable: SceneBindingForMapping[]): Promise<{ ok: true; scenes: SceneBindingForMapping[]; derivativeIds: string[]; requested: number; fromRegistry: number } | { ok: false; code: string; message: string; retryable?: boolean }> {
    const requests = this.clipRequests(renderable);
    if (requests.length === 0) return { ok: true, scenes: renderable, derivativeIds: [], requested: 0, fromRegistry: 0 };
    if (!this.clipDerivatives) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Media worker chưa được nối vào render — không cắt được clip" };
    let writes = Promise.resolve();
    const prepared = await this.clipDerivatives.prepare(
      job.projectId,
      job.createdByUserId,
      requests,
      async () => {
        await this.prisma.renderJob.update({ where: { id: job.id }, data: { clipsReady: { increment: 1 }, preparationLeaseUntil: new Date(Date.now() + LEASE_MS) } });
      },
      async (sceneId, code, message) => {
        writes = writes.then(async () => {
          const row = await this.prisma.renderJob.findUnique({ where: { id: job.id } });
          const failed = Array.isArray(row?.clipFailures) ? row.clipFailures : [];
          await this.prisma.renderJob.update({ where: { id: job.id }, data: { clipFailures: [...failed, { sceneId, code, message }] } });
        });
        await writes;
      },
    );
    if (!prepared.ok) return { ok: false, code: prepared.code, message: prepared.message, ...(prepared.retryable !== undefined ? { retryable: prepared.retryable } : {}) };
    const bySceneId = prepared.data.derivativeBySceneId;
    return {
      ok: true,
      scenes: renderable.map((scene) => (bySceneId.has(scene.sceneId) ? { ...scene, mediaAssetVersionId: bySceneId.get(scene.sceneId)! } : scene)),
      derivativeIds: [...bySceneId.values()],
      requested: requests.length,
      fromRegistry: (prepared.data.items ?? []).filter((item) => item.source === "registry").length,
    };
  }

  private async captionSources(scenes: SceneBindingForMapping[]): Promise<Map<string, PlanCaptionSource>> {
    const audioVersionIds = [...new Set(scenes.map((scene) => scene.audioVersionId).filter((id): id is string => Boolean(id)))];
    const result = new Map<string, PlanCaptionSource>();
    if (audioVersionIds.length === 0) return result;
    // V03-03: the subtitle version the timeline pinned (a user-edited one included), see `selectSubtitlesForScenes`. The TTS alignment
    // still rides along: `charTimingsForSegments` keeps real per-character timing for cues that match it and leaves edited cues to the
    // honest proportional estimate.
    const [audioRows, subtitles] = await Promise.all([
      this.prisma.audioVersion.findMany({ where: { id: { in: audioVersionIds } }, select: { id: true, alignment: true } }),
      selectSubtitlesForScenes(this.prisma, scenes),
    ]);
    const alignmentById = new Map(audioRows.map((row) => [row.id, row.alignment as unknown as CharacterAlignment | null]));
    for (const [audioVersionId, subtitle] of subtitles) {
      result.set(audioVersionId, { segments: subtitle.segments, alignment: alignmentById.get(audioVersionId) ?? null });
    }
    return result;
  }

  private async runCompose(job: JobRow, composeJob: VideoComposeJobInput): Promise<void> {
    let lastWrite = 0;
    const onProgress: ComposeVideoOptions["onProgress"] = (progress: VideoComposeProgress) => {
      const now = Date.now();
      if (now - lastWrite < PROGRESS_WRITE_EVERY_MS && progress.percent < 99) return;
      lastWrite = now;
      void this.prisma.renderJob
        .updateMany({ where: { id: job.id, status: { in: ["rendering", "verifying"] } }, data: { progress: Math.round(progress.percent), preparationLeaseUntil: new Date(now + LEASE_MS), ...(progress.stage === "qc" ? { status: "verifying" } : {}) } })
        .catch(() => undefined);
    };
    const timings = this.renderTimings.get(job.id);
    const composeStartedAt = Date.now();
    try {
      let result: VideoComposeResult;
      try {
        if (!this.composer) throw new MediaJobClientError("MEDIA_WORKER_NOT_CONFIGURED", "Media worker chưa được nối vào API");
        result = await this.composer.composeVideo(composeJob, { onProgress });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Không gọi được render worker";
        const code = error instanceof MediaJobClientError && error.code === "RESULT_TIMEOUT" ? "FFMPEG_TIMEOUT" : "INTERNAL";
        timings?.add("render_compose", composeStartedAt, Date.now(), { provider: "lyonix", ok: false, code });
        await this.handleFailure(job.id, { code, message, qc: null });
        return;
      }
      const composeEndedAt = Date.now();
      if (result.ok) {
        recordComposeStages(timings, composeStartedAt, composeEndedAt, result);
        const finalizeStartedAt = Date.now();
        await this.complete(job.id, result);
        timings?.add("render_finalize", finalizeStartedAt, Date.now(), { provider: "lyonix" });
      } else {
        timings?.add("render_compose", composeStartedAt, composeEndedAt, { provider: "lyonix", ok: false, code: result.error.code, detail: { attempts: result.error.attempts } });
        await this.handleFailure(job.id, { code: result.error.code, message: result.error.message, qc: result.qc ?? null });
      }
    } finally {
      await this.persistTimings(job);
    }
  }

  private async complete(jobId: string, result: Extract<VideoComposeResult, { ok: true }>): Promise<void> {
    const cpuSeconds = result.metrics.cpuSeconds ?? result.metrics.renderMs / 1000;
    const costUsd = (cpuSeconds / 3600) * this.cpuHourUsd;
    const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    await this.prisma.renderJob.updateMany({
      where: { id: jobId, status: { in: ["rendering", "verifying"] } },
      data: {
        status: "completed",
        progress: 100,
        resultUrl: `${base}/api/v1/render-jobs/${jobId}/file`,
        snapshotUrl: `${base}/api/v1/render-jobs/${jobId}/thumbnail`,
        resultExpiresAt: new Date(result.expiresAt),
        completedAt: new Date(),
        renderDurationMs: result.metrics.renderMs,
        costAmount: new Prisma.Decimal(costUsd.toFixed(4)),
        costCurrency: "USD",
        outputRelativePath: result.output.relativePath,
        outputSha256: result.output.sha256,
        outputBytes: result.output.bytes,
        outputProfileVersion: result.tool.profileVersion,
        thumbnailRelativePath: result.thumbnail.relativePath,
        outputWidth: result.output.width,
        outputHeight: result.output.height,
        qcReport: result.qc as unknown as Prisma.InputJsonValue,
        preparationLeaseUntil: null,
        lastError: Prisma.DbNull,
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------------- failure + fallback

  private async handleFailure(jobId: string, failure: { code: string; message: string; qc: unknown }): Promise<void> {
    const job = await this.prisma.renderJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;
    const payload = job.modificationsPayload as unknown as JobPayload;
    const context = await this.loadContext(job, payload);
    const error = { code: failure.code, message: failure.message };
    const qcData = failure.qc ? { qcReport: failure.qc as Prisma.InputJsonValue } : {};
    if (!context.ok) return this.finishFailed(job, error, "fallback_after_error", qcData);

    const decision = await this.decide(job, payload, context.data, { code: failure.code });
    if (decision.kind === "route" && decision.engine !== "lyonix") {
      // Create the fallback job BEFORE failing this one: the Auto run follows the newest job, so it never sees a transient "failed" state.
      const fallback = await this.createFallbackJob(job, payload, decision.snapshotId);
      return this.finishFailed(job, { ...error, ...(fallback ? { fallbackJobId: fallback.id } : {}) }, "fallback_after_error", qcData);
    }
    if (decision.kind === "blocked") return this.finishFailed(job, { code: "RENDER_BUDGET_EXHAUSTED", message: `${decision.detail}. Lỗi engine nội bộ: ${failure.code}: ${failure.message}`, cause: failure.code }, "budget_exhausted", qcData);
    // input-data error / already fell back / nothing to fall back to: the original error is the answer
    return this.finishFailed(job, error, null, qcData);
  }

  private async createFallbackJob(original: JobRow, payload: JobPayload, snapshotId: string): Promise<{ id: string } | null> {
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: snapshotId }, select: { providerAccountId: true } });
    if (!snapshot) return null;
    try {
      return await this.prisma.renderJob.create({
        data: {
          projectId: original.projectId,
          templateSnapshotId: snapshotId,
          providerAccountId: snapshot.providerAccountId,
          requestFingerprint: `fallback:${original.id}`,
          webhookToken: randomBytes(24).toString("base64url"),
          status: "preparing_clips",
          engine: "creatomate",
          routeReason: "fallback_after_error",
          fallbackOfJobId: original.id,
          modificationsPayload: { ...payload, mode: "dynamic", compose: undefined, forceEngine: null } as unknown as Prisma.InputJsonValue,
          createdByUserId: original.createdByUserId,
          clipsTotal: original.clipsTotal,
          clipsReady: 0,
          ...(original.workflowRunId ? { workflowRunId: original.workflowRunId } : {}),
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return this.prisma.renderJob.findUnique({ where: { requestFingerprint: `fallback:${original.id}` }, select: { id: true } });
      throw error;
    }
  }

  private async finishFailed(job: JobRow, error: Record<string, unknown>, reason: RenderRouteReason | null, extra: Record<string, unknown> = {}): Promise<void> {
    await this.prisma.renderJob.updateMany({
      where: { id: job.id, status: { notIn: ["completed", "cancelled"] } },
      data: { status: "failed", completedAt: new Date(), preparationLeaseUntil: null, lastError: { ...error, retryable: false } as unknown as Prisma.InputJsonValue, ...(reason ? { routeReason: reason } : {}), ...extra },
    });
  }

  private failJob(job: JobRow, code: string, message: string, reason: RenderRouteReason | null, retryable = false): Promise<void> {
    return this.prisma.renderJob
      .updateMany({
        where: { id: job.id, status: { in: ["preparing_clips", "rendering", "verifying"] } },
        data: { status: "failed", completedAt: new Date(), preparationLeaseUntil: null, lastError: { code, message, retryable } as unknown as Prisma.InputJsonValue, ...(reason ? { routeReason: reason } : {}) },
      })
      .then(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------------------------- recovery

  /**
   * A render whose API process died keeps status `rendering` with an expired lease and nobody tracking it. Put it back to `preparing_clips`:
   * the next tick re-runs the whole step, and `video.compose` is idempotent by jobKey (the worker returns the stored render if it finished).
   */
  async recoverStale(now = new Date()): Promise<boolean> {
    const stale = await this.prisma.renderJob.findFirst({ where: { engine: "lyonix", status: { in: ["rendering", "verifying"] }, preparationLeaseUntil: { lt: now } }, orderBy: { createdAt: "asc" } });
    if (!stale || this.inflight.has(stale.id)) return false;
    const moved = await this.prisma.renderJob.updateMany({ where: { id: stale.id, status: stale.status, preparationLeaseUntil: stale.preparationLeaseUntil }, data: { status: "preparing_clips", preparationLeaseUntil: null, progress: null } });
    return moved.count === 1;
  }

  private toResponse(row: JobRow): RenderJobResponse {
    return {
      id: row.id,
      projectId: row.projectId,
      templateSnapshotId: row.templateSnapshotId,
      status: row.status as RenderJobResponse["status"],
      engine: row.engine as RenderEngine,
      routeReason: (row.routeReason ?? null) as RenderRouteReason | null,
      fallbackOfJobId: row.fallbackOfJobId ?? null,
      externalJobId: row.externalJobId,
      progress: row.progress,
      clipPreparation: { clipsTotal: row.clipsTotal ?? 0, clipsReady: row.clipsReady ?? 0, failed: [] },
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
    };
  }
}

