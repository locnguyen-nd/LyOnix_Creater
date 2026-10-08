/**
 * VE2E-06: background executor for one Auto `WorkflowRun` — the DAG
 * source→script(auto-approve)→voice→media→timeline→render described in
 * VE2E-VIDEO-PRODUCTION.md §1/§4/§5. Never runs inside `apps/api`'s HTTP request path
 * (see `video-productions.service.ts`); intended to be polled by a separate process
 * (`workflow-worker-main.ts`), the same "enqueue in the request, execute in a worker
 * loop" shape `AudioVersionsService.processNext()` already established.
 *
 * Every provider-calling step is wrapped in `recordStep()`, which writes a `StepRun`
 * (+ a `ProviderOperation` when the step actually calls a provider) before/after
 * execution — the durable per-step trail + shared `correlationId` the spec's §3 asks
 * for ("mọi step có input/output version refs và correlation ID").
 *
 * VE2E-133: media sourcing runs in PARALLEL with TTS (planned with `durationHintMs`; real voice durations only cut the ranges, and a
 * changed plan re-searches only new/uncovered segments, see `workflow-media-resume.ts`). A retried run is still re-queued as a whole
 * (status back to `draft`, `attempts` incremented) but resumes cheaply: approved script, `current` AudioVersions and project-library
 * media found by the earlier attempt are reused, and `resume_diagnostics` records which steps were resumed.
 *
 * Bounded retry / cost ceiling (known, documented scope limits): a transient provider failure re-queues
 * the run, bounded by `AutomationProfileVersion.retryPolicy.maxAttempts`
 * (default 2). `costCeiling` is persisted/exposed on the profile but not enforced
 * against real spend in this pass: no adapter in this codebase currently returns
 * actual per-call cost/usage (`packages/providers`' `UsageRecord`/`CostEstimate`
 * types are defined but never populated by any live adapter — confirmed by
 * repo-wide grep before writing this) — wiring real per-provider cost/usage into a
 * `CostLedger` is a separate, adapter-level scope change, not invented here.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import type { WorkflowRun as WorkflowRunRow } from "@lyonix/db";
import type { DurationBudgetDiagnostics, MediaPlanApifyUsage, MediaPlanSegmentDiagnostics, MediaPlanVisionUsage, OrshotRenderOptions } from "@lyonix/contracts";
import { sanitizeOrshotOptions } from "./orshot-render.js";
import { EarlyClipCutter, earlyClipCutEnabled } from "./workflow-early-clips.js";
import { ClipDerivativesService } from "./clip-derivatives.service.js";
import { ensureUniqueSegmentIds, orderByScript, reconcileSourcedSegments, sameSegmentStructure } from "./workflow-media-resume.js";
import {
  buildAutoRenderAssignments,
  buildAutoTimelineOptionValues,
  buildNarrationBudget,
  calibrateCharsPerSecond,
  checkDurationBand,
  qualityGateConfigFromEnv,
  runQualityGate,
  type QualityGateAsset,
  type QualityGateResult,
  type QualityGateScene,
  type NarrationBudget,
  readBackgroundSegmentsSetting,
  resolveBackgroundSegmentRange,
  type PlannedSegment,
  type AutoSceneMedia,
  type AutoTemplateSlot,
  deriveSceneVisualKinds,
  mergeScenesToCap,
  narrationLengthCorrection,
  orshotMaxScenes,
  orshotPageCount,
  splitSegmentsByVisualKind,
} from "@lyonix/domain";
import { ProviderError, type ProviderLimiter, type ProviderLimiterKey } from "@lyonix/providers";
import { AudioVersionsService } from "./audio-versions.service.js";
import { getSharedProviderLimiter, mapBounded, resolveConcurrencyConfig } from "./concurrency-config.js";
import { MediaPlanService, SegmentSourceLedger, applyExtractedKeywords, segmentNarration, segmentsNeedingKeywords, type MediaPlanScript, type SourcedSegment } from "./media-plan.service.js";
import { countTemplateSceneSlots } from "@lyonix/providers";
import { fixedSlotPathApplies } from "./render-mode.js";
import { PrismaService } from "./prisma.service.js";
import { RenderJobsService } from "./render-jobs.service.js";
import { ScriptGenerationService } from "./script-generation.service.js";
import { ScriptVersionsService } from "./script-versions.service.js";
import { SourcesService } from "./sources.service.js";
import { TimelineVersionsService } from "./timeline-versions.service.js";

// --- AutomationProfileVersion JSON config parsing (shared with video-productions.service.ts) ---

export type ContentAccountRef = { providerAccountId: string };
export type VoiceAccountRef = { providerAccountId: string; voiceId?: string; modelId?: string };
export type RenderAccountRef = { providerAccountId: string; templateSnapshotId: string; outputFormat?: "mp4" | "mov" | "gif"; /** Orshot accounts only: sanitized render options (format/fps/size/fit-to-narration). */ orshot?: OrshotRenderOptions };

export const asAccountRef = (value: unknown): ContentAccountRef | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.providerAccountId === "string" && record.providerAccountId ? { providerAccountId: record.providerAccountId } : null;
};

export const asVoiceRef = (value: unknown): VoiceAccountRef | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.providerAccountId !== "string" || !record.providerAccountId) return null;
  return {
    providerAccountId: record.providerAccountId,
    ...(typeof record.voiceId === "string" && record.voiceId ? { voiceId: record.voiceId } : {}),
    ...(typeof record.modelId === "string" && record.modelId ? { modelId: record.modelId } : {}),
  };
};

export const asRenderRef = (value: unknown): RenderAccountRef | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.providerAccountId !== "string" || !record.providerAccountId) return null;
  if (typeof record.templateSnapshotId !== "string" || !record.templateSnapshotId) return null;
  const outputFormat = record.outputFormat;
  const orshot = sanitizeOrshotOptions(record.orshot);
  return {
    providerAccountId: record.providerAccountId,
    templateSnapshotId: record.templateSnapshotId,
    ...(outputFormat === "mp4" || outputFormat === "mov" || outputFormat === "gif" ? { outputFormat } : {}),
    ...(orshot.ok && Object.keys(orshot.data).length > 0 ? { orshot: orshot.data } : {}),
  };
};

const AUTO_DIRECTION_BY_LOCALE: Record<string, (durationSec: number, sceneCount: number) => string> = {
  vi: (d, s) => `Video khoảng ${d} giây, chia thành ${s} cảnh, giọng điệu tự nhiên, phù hợp định dạng dọc TikTok/Shorts.`,
  en: (d, s) => `Video around ${d} seconds, split into ${s} scenes, natural tone, suited for a vertical TikTok/Shorts format.`,
  ja: (d, s) => `動画は約${d}秒、${s}のシーンに分割し、TikTok/Shorts向けの縦型フォーマットに合う自然なトーンにしてください。`,
  ko: (d, s) => `영상은 약 ${d}초, ${s}개 장면으로 나누고 TikTok/Shorts 세로 포맷에 맞는 자연스러운 톤으로 만들어 주세요.`,
};
const buildAutoDirection = (locale: string, durationSec: number, sceneCount: number): string =>
  (AUTO_DIRECTION_BY_LOCALE[locale] ?? AUTO_DIRECTION_BY_LOCALE.vi!)(durationSec, sceneCount);

/** Normalized failure raised by a pipeline step; every service call this runner makes already returns an `{ok:false,code,message}` outcome instead of throwing, so each step site converts that into this before `recordStep()`'s catch handles it uniformly. */
export class WorkflowStepFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const BLOCKED_CODES = new Set(["PROVIDER_NOT_CONFIGURED", "PROVIDER_CAPABILITY_UNAVAILABLE", "PROVIDER_AUTH_INVALID", "SSRF_BLOCKED"]);
const NEEDS_INPUT_CODES = new Set(["VALIDATION_FAILED", "PROVIDER_SCHEMA_INVALID", "PROVIDER_CONTENT_REFUSED", "INVALID_STATE", "VERSION_CONFLICT", "NOT_FOUND", "FORBIDDEN", "MEDIA_RELEVANCE_BELOW_THRESHOLD", "MEDIA_RELEVANCE_UNVERIFIED", "MEDIA_RIGHTS_UNRESOLVED"]);
/** Everything else (PROVIDER_RATE_LIMITED/PROVIDER_QUOTA_EXHAUSTED/PROVIDER_TIMEOUT/PROVIDER_UNAVAILABLE/PROVIDER_SUBMIT_UNKNOWN, and any unexpected thrown error) is treated as transient and bounded-retried — never an infinite loop since `attempts` is capped. */
const classify = (code: string): "blocked_provider" | "needs_input" | "retry" => {
  if (BLOCKED_CODES.has(code)) return "blocked_provider";
  if (NEEDS_INPUT_CODES.has(code)) return "needs_input";
  return "retry";
};

/** WorkflowStepFailure and ProviderError (e.g. a limiter wait timeout = PROVIDER_RATE_LIMITED) keep their own code; anything else is a transient PROVIDER_UNAVAILABLE. */
const errorCodeOf = (error: unknown): string => (error instanceof WorkflowStepFailure || error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE");

const DEFAULT_MAX_ATTEMPTS = 2;

type ProviderStepMeta = { role: "content" | "tts" | "visual" | "render"; operation: string; providerAccountId: string };

/** VE2E-50/54: one paid call recorded in the run-level `run_usage` ledger. */
export type RunUsageEntry = {
  step: string;
  kind: "content" | "tts";
  provider: string | null;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costAmount: string | null;
  costCurrency: string | null;
  /** TTS only: characters sent to the provider. */
  characters?: number;
  /** VE2E-57: number of provider requests this entry stands for (vision moderation batches all of a job's calls into one entry). */
  calls?: number;
  at: string;
};

/** VE2E-133: the early (parallel) and the post-TTS sourcing passes are one job: their Apify spend adds up. */
const mergeApifyUsage = (a: MediaPlanApifyUsage | null, b: MediaPlanApifyUsage | null): MediaPlanApifyUsage | null => {
  if (!a || !b) return a ?? b;
  return { runs: a.runs + b.runs, seconds: a.seconds + b.seconds, usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0), searchesReused: a.searchesReused + b.searchesReused, libraryReuses: a.libraryReuses + b.libraryReuses };
};
const mergeVisionUsage = (a: MediaPlanVisionUsage | null, b: MediaPlanVisionUsage | null): MediaPlanVisionUsage | null => {
  if (!a || !b) return a ?? b;
  return { calls: a.calls + b.calls, moderated: a.moderated + b.moderated, skippedSegments: a.skippedSegments + b.skippedSegments, maxCalls: a.maxCalls + b.maxCalls, modelId: a.modelId ?? b.modelId };
};

const envMs = (name: string, fallback: number, min: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? value : fallback;
};
/** VE2E-139: how often a worker touches the runs it owns. */
export const workflowHeartbeatMs = () => envMs("WORKFLOW_HEARTBEAT_MS", 30_000, 1_000);
/** VE2E-139: a run untouched for this long is considered orphaned. */
export const workflowStaleMs = () => envMs("WORKFLOW_STALE_MS", 180_000, 5_000);
const workflowRecoveryMaxAttempts = () => Math.floor(envMs("WORKFLOW_RECOVERY_MAX_ATTEMPTS", 3, 1));

@Injectable()
export class WorkflowRunnerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SourcesService) private readonly sources: SourcesService,
    @Inject(ScriptGenerationService) private readonly scriptGeneration: ScriptGenerationService,
    @Inject(ScriptVersionsService) private readonly scriptVersions: ScriptVersionsService,
    @Inject(AudioVersionsService) private readonly audioVersions: AudioVersionsService,
    @Inject(MediaPlanService) private readonly mediaPlans: MediaPlanService,
    @Inject(RenderJobsService) private readonly renderJobs: RenderJobsService,
    @Inject(TimelineVersionsService) private readonly timelines: TimelineVersionsService,
    // VE2E-134b: optional so a worker without the media-jobs wiring simply skips early cutting (the render step cuts as before).
    @Optional() @Inject(ClipDerivativesService) private readonly clipDerivatives?: ClipDerivativesService,
  ) {}

  /** VE2E-61: test/DI overrides (plain fields, not constructor params, so Nest DI is unaffected); default = shared process limiter + env config. */
  limiter: ProviderLimiter | null = null;
  voiceParallelism: number = resolveConcurrencyConfig().voiceParallelism;

  /** One tick: claim+run at most one draft Auto run, then reconcile every run waiting on a render. Returns whether anything happened (used by the worker loop to decide whether to sleep). */
  async processNext(): Promise<boolean> {
    const started = await this.startNextDraft();
    if (started !== null && started !== "lost_race") await started.done;
    const reconciledAny = await this.reconcileRenders();
    return started !== null || reconciledAny;
  }

  /**
   * VE2E-61: atomically claims the oldest `draft` run (`updateMany where status=draft` -> exactly one worker/tick wins) and starts
   * its pipeline WITHOUT awaiting it, so the worker loop can keep several runs in flight (`WORKFLOW_CONCURRENCY`).
   * Returns `null` when nothing is queued, `"lost_race"` when another tick/replica claimed the candidate first (caller may
   * immediately try the next one), else the `{ done }` handle of the started run (`done` never rejects: failures go through handleFailure).
   */
  async startNextDraft(): Promise<{ done: Promise<void> } | "lost_race" | null> {
    const candidate = await this.prisma.workflowRun.findFirst({ where: { mode: "auto", status: "draft" }, orderBy: { createdAt: "asc" } });
    if (!candidate) return null;
    const claimed = await this.prisma.workflowRun.updateMany({ where: { id: candidate.id, status: "draft" }, data: { status: "source_ready" } });
    if (claimed.count !== 1) return "lost_race";
    const run: WorkflowRunRow = { ...candidate, status: "source_ready" };
    // VE2E-139: heartbeat while this process owns the run, so `recoverStaleRuns` can tell a live run from one whose worker died.
    const heartbeat = setInterval(() => {
      void this.prisma.workflowRun.update({ where: { id: run.id }, data: { updatedAt: new Date() } }).catch(() => undefined);
    }, workflowHeartbeatMs());
    heartbeat.unref?.();
    const done = (async () => {
      try {
        await this.runPipeline(run);
      } catch (error) {
        try {
          await this.handleFailure(run, error);
        } catch (failure) {
          console.error("Workflow run failure handling failed", run.id, failure instanceof Error ? failure.message : "unknown error");
        }
      } finally {
        clearInterval(heartbeat);
      }
    })();
    return { done };
  }

  /**
   * VE2E-139: re-queues Auto runs whose worker died mid-pipeline. A run in an active pre-render status that has not been touched
   * (heartbeat / status change) for `WORKFLOW_STALE_MS` (default 3 min, 6 missed heartbeats) goes back to `draft` with its attempt
   * counter bumped; steps left `running` become `failed` (WORKER_LOST) so the resume logic redoes only them. After
   * `WORKFLOW_RECOVERY_MAX_ATTEMPTS` (default 3) the run fails visibly instead of looping. Returns how many runs were recovered.
   */
  async recoverStaleRuns(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - workflowStaleMs());
    const stale = await this.prisma.workflowRun.findMany({
      where: { mode: "auto", deletedAt: null, status: { in: ["source_ready", "scripting", "voice_generating", "aligning", "media_preparing", "editing", "ready_to_render"] }, updatedAt: { lt: cutoff } },
      select: { id: true, attempts: true },
      take: 20,
    });
    let recovered = 0;
    for (const run of stale) {
      const lost = { code: "WORKER_LOST", message: "Worker dừng giữa chừng; run được xếp lại hàng đợi", retryable: true };
      const exhausted = run.attempts >= workflowRecoveryMaxAttempts();
      const claimed = await this.prisma.workflowRun.updateMany({
        where: { id: run.id, updatedAt: { lt: cutoff } },
        data: exhausted ? { status: "failed", lastError: { ...lost, retryable: false, message: "Worker dừng giữa chừng nhiều lần liên tiếp" } } : { status: "draft", attempts: { increment: 1 }, lastError: lost },
      });
      if (claimed.count !== 1) continue;
      await this.prisma.stepRun.updateMany({ where: { workflowRunId: run.id, status: "running" }, data: { status: "failed", error: lost, endedAt: now } }).catch(() => undefined);
      await this.prisma.providerOperation.updateMany({ where: { workflowRunId: run.id, status: "in_progress" }, data: { status: "failed", errorCode: "WORKER_LOST" } }).catch(() => undefined);
      recovered += 1;
    }
    return recovered;
  }

  /** Claims up to `limit - inflight.size` draft runs and tracks them in `inflight` (frees a slot when a run ends). Returns how many started. */
  async fillSlots(inflight: Set<Promise<void>>, limit: number): Promise<number> {
    let started = 0;
    let lostRaces = 0;
    while (inflight.size < limit) {
      const handle = await this.startNextDraft();
      if (handle === null) break;
      if (handle === "lost_race") {
        if (++lostRaces >= 3) break;
        continue;
      }
      const tracked: Promise<void> = handle.done.finally(() => { inflight.delete(tracked); });
      inflight.add(tracked);
      started += 1;
    }
    return started;
  }

  /** Reconciles runs parked on a render (public so the concurrent worker loop can call it between claims). */
  reconcile(): Promise<boolean> {
    return this.reconcileRenders();
  }

  /** VE2E-61: runs `fn` behind the process-wide per-provider limiter (FIFO wait + timeout, cooldown aware) shared by every job. */
  private limited<T>(key: ProviderLimiterKey, fn: () => Promise<T>): Promise<T> {
    return (this.limiter ?? getSharedProviderLimiter()).run(key, fn);
  }

  private async actorFor(userId: string): Promise<{ userId: string; role: "admin" | "staff" } | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    return user ? { userId: user.id, role: user.role } : null;
  }

  private async setStatus(id: string, status: WorkflowRunRow["status"]) {
    await this.prisma.workflowRun.update({ where: { id }, data: { status } });
  }

  /**
   * Writes a `StepRun` (and, when `meta` is given, a `ProviderOperation` sharing the
   * run's own `correlationId`) around `fn`. `fn` must throw `WorkflowStepFailure` for
   * a normalized outcome failure — every call site below does this immediately after
   * checking `outcome.ok`, so this stays the single place that persists step/operation
   * bookkeeping instead of every step re-implementing it.
   */
  private async recordStep<T>(run: WorkflowRunRow, stepKey: string, meta: ProviderStepMeta | null, fn: () => Promise<T>): Promise<T> {
    const stepRun = await this.prisma.stepRun.upsert({
      where: { workflowRunId_stepKey_attempt: { workflowRunId: run.id, stepKey, attempt: run.attempts } },
      create: { workflowRunId: run.id, stepKey, attempt: run.attempts, status: "running", startedAt: new Date() },
      update: { status: "running", startedAt: new Date(), endedAt: null, error: Prisma.JsonNull },
    });
    let operationId: string | null = null;
    if (meta) {
      const operation = await this.prisma.providerOperation.create({
        data: {
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          providerAccountId: meta.providerAccountId,
          role: meta.role,
          operation: meta.operation,
          status: "in_progress",
          correlationId: run.correlationId,
        },
      });
      operationId = operation.id;
    }
    try {
      const value = await fn();
      await this.prisma.stepRun.update({ where: { id: stepRun.id }, data: { status: "succeeded", endedAt: new Date() } });
      if (operationId) {
        const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
        const pin = record?.providerPin && typeof record.providerPin === "object" ? record.providerPin as Record<string, unknown> : null;
        const modelId = typeof pin?.modelId === "string" ? pin.modelId : typeof record?.modelId === "string" ? record.modelId : null;
        await this.prisma.providerOperation.update({ where: { id: operationId }, data: { status: "succeeded", ...(modelId ? { modelId } : {}) } });
      }
      return value;
    } catch (error) {
      const code = errorCodeOf(error);
      const message = error instanceof Error ? error.message : "Lỗi không xác định";
      await this.prisma.stepRun.update({ where: { id: stepRun.id }, data: { status: "failed", endedAt: new Date(), error: { code, message } } });
      if (operationId) await this.prisma.providerOperation.update({ where: { id: operationId }, data: { status: "failed", errorCode: code } });
      throw error;
    }
  }

  /** Persists a diagnostics blob as a succeeded StepRun outputRef (no migration). Best-effort: diagnostics must never fail the pipeline. */
  private async saveStepDiagnostics(run: WorkflowRunRow, stepKey: string, value: unknown): Promise<void> {
    try {
      const output = value as Prisma.InputJsonValue;
      const now = new Date();
      await this.prisma.stepRun.upsert({
        where: { workflowRunId_stepKey_attempt: { workflowRunId: run.id, stepKey, attempt: run.attempts } },
        create: { workflowRunId: run.id, stepKey, attempt: run.attempts, status: "succeeded", startedAt: now, endedAt: now, outputRef: output },
        update: { status: "succeeded", endedAt: now, outputRef: output },
      });
    } catch {
      // Diagnostics must never fail the pipeline.
    }
  }

  /** VE2E-48: persists per-segment sourceProvider + fallbackReason as the `media_plan_diagnostics` StepRun outputRef (read by GET /video-productions/:id). VE2E-51: per-job Apify spend (runs, seconds, USD) rides along. */
  private saveMediaSourcingDiagnostics(run: WorkflowRunRow, segments: MediaPlanSegmentDiagnostics[], apifyUsage: MediaPlanApifyUsage | null = null, visionUsage: MediaPlanVisionUsage | null = null): Promise<void> {
    return this.saveStepDiagnostics(run, "media_plan_diagnostics", { segments, ...(apifyUsage ? { apifyUsage } : {}), ...(visionUsage ? { visionUsage } : {}) });
  }

  /**
   * VE2E-50/54: run-level usage ledger (`run_usage` StepRun outputRef): one entry per paid call
   * (script generation, keyword extraction, script regeneration, TTS) so the spend of a run,
   * including the bounded corrections, is countable in one place. Best-effort.
   */
  private async appendRunUsage(run: WorkflowRunRow, entry: RunUsageEntry): Promise<void> {
    // VE2E-133: voice and media sourcing run in parallel and BOTH append to the same `run_usage` row (read-modify-write): serialize per run so no entry is lost.
    const previous = this.usageChains.get(run.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const existing = await this.prisma.stepRun.findUnique({ where: { workflowRunId_stepKey_attempt: { workflowRunId: run.id, stepKey: "run_usage", attempt: run.attempts } } });
        const entries = (existing?.outputRef as { entries?: RunUsageEntry[] } | null)?.entries;
        await this.saveStepDiagnostics(run, "run_usage", { entries: [...(Array.isArray(entries) ? entries : []), entry] });
      } catch {
        // Best-effort.
      }
    });
    this.usageChains.set(run.id, next);
    await next;
    if (this.usageChains.get(run.id) === next) this.usageChains.delete(run.id);
  }

  /** VE2E-133: per-run append chains for `run_usage` (the only class-level mutable state; keyed by run id, so concurrent runs never share an entry). */
  private readonly usageChains = new Map<string, Promise<void>>();

  /** Never rejects: lets two parallel branches both finish before the first failure is rethrown (no orphaned promise, no unobserved rejection). */
  private settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  }

  /**
   * VE2E-133: which steps a retried run (attempt > 1) did NOT redo, and where the previous attempt stopped. Persisted as the
   * `resume_diagnostics` StepRun outputRef (best-effort). The reuse itself comes from the existing idempotent steps: approved script,
   * `current` AudioVersion per scene, project-library asset per segment (`findReusableSource`), extracted source.
   */
  private async saveResumeDiagnostics(run: WorkflowRunRow, reuse: { reusedScript: boolean; reusedAudioScenes: number; totalScenes: number; reusedMediaSegments: number; totalMediaSegments: number }): Promise<void> {
    try {
      let previousAttempt: { failedStep: string | null; succeededSteps: string[] } | null = null;
      if (run.attempts > 1) {
        try {
          const rows = await this.prisma.stepRun.findMany({ where: { workflowRunId: run.id, attempt: run.attempts - 1 }, select: { stepKey: true, status: true, startedAt: true }, orderBy: { startedAt: "asc" } });
          const failed = rows.find((row) => row.status === "failed");
          previousAttempt = { failedStep: failed?.stepKey ?? null, succeededSteps: rows.filter((row) => row.status === "succeeded").map((row) => row.stepKey) };
        } catch {
          previousAttempt = null;
        }
      }
      await this.saveStepDiagnostics(run, "resume_diagnostics", { attempt: run.attempts, resumed: run.attempts > 1, ...reuse, previousAttempt });
    } catch {
      // Diagnostics must never fail the pipeline.
    }
  }

  /**
   * VE2E-50: the dedicated keyword-extraction call. For every not-yet-sourced segment without a valid
   * Japanese search keyword (plan missing, or ja failed validation) ONE cheap content call derives ja+en
   * keywords from the narration (never from `visualQuery`), cost-tracked in `run_usage`. Only runs when
   * the user can actually search Apify. Never throws: on any failure the segments keep no keyword and
   * sourcing falls back to Pexels with reason `no_ja_keywords`.
   */
  private async extractMissingKeywords(
    run: WorkflowRunRow,
    ctx: { userId: string; role: "admin" | "staff"; contentAccountId: string; script: MediaPlanScript; title: string; segments: PlannedSegment[] },
  ): Promise<void> {
    const needing = segmentsNeedingKeywords(ctx.segments);
    if (needing.length === 0) {
      // The script's own visualPlan already carries valid Japanese keywords: record that as the keyword stage (no extra LLM call).
      await this.recordStep(run, "keywords_from_script", null, async () => ({ source: "visualPlan", segments: ctx.segments.map((segment) => ({ segmentId: segment.segmentId, ja: segment.keywords?.ja ?? null, en: segment.keywords?.en ?? null })) })).catch(() => undefined);
      return;
    }
    if (!(await this.mediaPlans.apifyAvailable(ctx.userId, ctx.role))) return;
    const requested = needing.map((segment) => segment.segmentId);
    try {
      const outcome = await this.recordStep(
        run,
        "extract_keywords",
        { role: "content", operation: "extract_keywords", providerAccountId: ctx.contentAccountId },
        () => this.limited("content", async () => {
          const result = await this.scriptGeneration.extractSegmentKeywords(ctx.userId, ctx.role, {
            providerAccountId: ctx.contentAccountId,
            language: ctx.script.language,
            title: ctx.title,
            segments: needing.map((segment) => ({ segmentId: segment.segmentId, narration: segmentNarration(ctx.script, segment) })),
          });
          if (!result.ok) throw new WorkflowStepFailure(result.code, result.message);
          return result;
        }),
      );
      applyExtractedKeywords(ctx.segments, outcome.keywords);
      await this.appendRunUsage(run, { step: "extract_keywords", kind: "content", provider: outcome.provider, modelId: outcome.modelId, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, costAmount: outcome.usage.costAmount, costCurrency: outcome.usage.costCurrency, at: new Date().toISOString() });
      await this.saveStepDiagnostics(run, "keyword_extraction_diagnostics", { requested, extracted: Object.keys(outcome.keywords), rejected: outcome.rejectedSegmentIds, modelId: outcome.modelId });
    } catch (error) {
      await this.saveStepDiagnostics(run, "keyword_extraction_diagnostics", { requested, extracted: [], failed: error instanceof Error ? error.message.slice(0, 200) : "error", reason: "no_ja_keywords" });
    }
  }

  /**
   * VE2E-85: pre-render quality gate. Reads the plan, applies the auto-fixes (other window / other clip of the job) to `mediaPlan` in place and records
   * the `quality_gate` StepRun (checks, fixes, warnings, quality_degraded summary). Only an invalid range stops the run (VALIDATION_FAILED, clear reason);
   * warnings and degraded sources never do. An internal gate error is swallowed: the gate must never be the reason a job is lost. `QUALITY_GATE=0` disables it.
   */
  private async applyQualityGate(
    run: WorkflowRunRow,
    ctx: {
      mediaPlan: ReturnType<MediaPlanService["buildBindings"]>;
      sourced: SourcedSegment[];
      narrationByScene: Map<string, string>;
      durationByScene: Map<string, number>;
      targetSec: number;
    },
  ): Promise<void> {
    const config = qualityGateConfigFromEnv();
    if (!config.enabled) return;
    let result: QualityGateResult;
    try {
      const degradedBySegment = new Map(ctx.sourced.map((piece) => [piece.segment.segmentId, piece.source?.degraded ?? null] as const));
      const sourceByAsset = new Map(ctx.sourced.flatMap((piece) => (piece.source ? [[piece.source.mediaAssetVersionId, piece.source] as const] : [])));
      let dims = new Map<string, { widthPx: number | null; heightPx: number | null }>();
      try {
        const rows: Array<{ id: string; widthPx: number | null; heightPx: number | null }> = await this.prisma.mediaAssetVersion.findMany({ where: { id: { in: [...sourceByAsset.keys()] } }, select: { id: true, widthPx: true, heightPx: true } });
        dims = new Map(rows.map((row) => [row.id, { widthPx: row.widthPx, heightPx: row.heightPx }] as const));
      } catch {
        // Unknown resolution is simply not checked.
      }
      const assets: QualityGateAsset[] = [...sourceByAsset.entries()].map(([id, source]) => ({ id, kind: source.kind, durationMs: source.durationMs, widthPx: dims.get(id)?.widthPx ?? null, heightPx: dims.get(id)?.heightPx ?? null }));
      const scenes: QualityGateScene[] = ctx.mediaPlan.scenes.map((scene) => ({
        sceneId: scene.sceneId,
        segmentId: scene.segmentId,
        assetId: scene.mediaAssetVersionId,
        kind: scene.mediaKind,
        sourceStartMs: scene.sourceStartMs,
        sourceDurationMs: scene.sourceDurationMs,
        sceneDurationMs: ctx.durationByScene.get(scene.sceneId) ?? 0,
        narration: ctx.narrationByScene.get(scene.sceneId) ?? "",
        degradedTier: scene.segmentId ? degradedBySegment.get(scene.segmentId) ?? null : null,
      }));
      result = runQualityGate({ scenes, assets, targetSec: ctx.targetSec, config });
    } catch {
      return;
    }
    if (!result.failure) {
      const byScene = new Map(result.scenes.map((scene) => [scene.sceneId, scene] as const));
      for (const target of ctx.mediaPlan.scenes) {
        const fixed = byScene.get(target.sceneId);
        if (!fixed) continue;
        target.mediaAssetVersionId = fixed.assetId;
        target.mediaKind = fixed.kind;
        target.sourceStartMs = fixed.sourceStartMs;
      }
      for (const fix of result.fixes) {
        if (fix.type !== "source_swapped") continue;
        const segment = ctx.mediaPlan.segments.find((candidate) => candidate.segmentId === fix.segmentId);
        if (segment) segment.mediaAssetVersionId = fix.toAssetId;
      }
    }
    await this.saveStepDiagnostics(run, "quality_gate", { checks: result.checks, fixes: result.fixes, warnings: result.warnings, degraded: result.degraded, failure: result.failure });
    if (result.failure) throw new WorkflowStepFailure("VALIDATION_FAILED", `Cổng chất lượng: ${result.failure.reason}`);
  }

  /** VE2E-54: chars/sec from this voice's (and model's) historical scene audio in the run's language -> narration budget for the script prompt. Best-effort: any failure falls back to the language default. */
  private async resolveNarrationBudget(targetSec: number, language: string, voiceId: string, modelId?: string): Promise<{ budget: NarrationBudget; calibrationSource: "history" | "default" }> {
    let samples: Array<{ chars: number; durationMs: number }> = [];
    try {
      const rows = await this.prisma.audioVersion.findMany({
        where: { externalVoiceId: voiceId, ...(modelId ? { modelId } : {}), sceneDraftVersion: { scriptDraftVersion: { language } } },
        orderBy: { createdAt: "desc" },
        take: 80,
        select: { durationMs: true, sceneDraftVersion: { select: { narration: true } } },
      });
      samples = (rows ?? []).map((row) => ({ chars: row.sceneDraftVersion.narration.length, durationMs: row.durationMs }));
    } catch {
      samples = [];
    }
    const calibration = calibrateCharsPerSecond(samples, language);
    return { budget: buildNarrationBudget({ targetSec, charsPerSecond: calibration.charsPerSecond }), calibrationSource: calibration.source };
  }

  /** VE2E-54: persists target vs real total scene voice duration as the `duration_budget` StepRun outputRef (read by GET /video-productions/:id). Best-effort; never fails the pipeline. */
  private async saveDurationBudget(run: WorkflowRunRow, diagnostics: DurationBudgetDiagnostics): Promise<void> {
    try {
      const output = diagnostics as unknown as Prisma.InputJsonValue;
      const now = new Date();
      await this.prisma.stepRun.upsert({
        where: { workflowRunId_stepKey_attempt: { workflowRunId: run.id, stepKey: "duration_budget", attempt: run.attempts } },
        create: { workflowRunId: run.id, stepKey: "duration_budget", attempt: run.attempts, status: "succeeded", startedAt: now, endedAt: now, outputRef: output },
        update: { status: "succeeded", endedAt: now, outputRef: output },
      });
    } catch {
      // Diagnostics must never fail the pipeline.
    }
  }

  private async handleFailure(run: WorkflowRunRow, error: unknown): Promise<void> {
    const code = errorCodeOf(error);
    const message = error instanceof Error ? error.message : "Lỗi không xác định trong workflow runner";
    const bucket = classify(code);
    if (bucket === "retry") {
      const profile = run.automationProfileVersionId ? await this.prisma.automationProfileVersion.findUnique({ where: { id: run.automationProfileVersionId } }) : null;
      const retryPolicy = (profile?.retryPolicy ?? {}) as { maxAttempts?: number };
      const maxAttempts = typeof retryPolicy.maxAttempts === "number" && retryPolicy.maxAttempts > 0 ? retryPolicy.maxAttempts : DEFAULT_MAX_ATTEMPTS;
      if (run.attempts < maxAttempts) {
        await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: "draft", attempts: { increment: 1 }, lastError: { code, message, retryable: true } } });
        return;
      }
    }
    const status = bucket === "blocked_provider" ? "blocked_provider" : bucket === "needs_input" ? "needs_input" : "failed";
    await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status, lastError: { code, message } } });
  }

  private async runPipeline(run: WorkflowRunRow): Promise<void> {
    const actor = await this.actorFor(run.createdByUserId);
    if (!actor) throw new WorkflowStepFailure("NOT_FOUND", "Người tạo video production không còn tồn tại");
    const { userId, role } = actor;

    if (!run.automationProfileVersionId) throw new WorkflowStepFailure("VALIDATION_FAILED", "WorkflowRun thiếu automationProfileVersionId");
    const profile = await this.prisma.automationProfileVersion.findUnique({ where: { id: run.automationProfileVersionId } });
    if (!profile) throw new WorkflowStepFailure("NOT_FOUND", "Không tìm thấy automation profile");

    const contentConfig = asAccountRef(profile.contentConfig);
    const voiceConfig = asVoiceRef(profile.voiceConfig);
    const mediaConfig = asAccountRef(profile.mediaConfig);
    const renderConfig = asRenderRef(profile.renderConfig);
    if (!contentConfig || !voiceConfig?.voiceId || !mediaConfig || !renderConfig) {
      throw new WorkflowStepFailure("PROVIDER_NOT_CONFIGURED", "Automation profile thiếu contentConfig/voiceConfig(voiceId)/mediaConfig/renderConfig cần cho Auto");
    }
    if (!run.sourceVersionId) throw new WorkflowStepFailure("VALIDATION_FAILED", "WorkflowRun thiếu sourceVersionId");
    const sourceVersionId = run.sourceVersionId;

    // --- 1. source ready (extract article_url if needed) ---
    const source = await this.prisma.sourceVersion.findUnique({ where: { id: sourceVersionId } });
    if (!source) throw new WorkflowStepFailure("NOT_FOUND", "Không tìm thấy nguồn của video production này");
    if (source.type === "article_url" && source.fetchStatus !== "extracted") {
      await this.recordStep(run, "extract_source", null, async () => {
        const result = await this.sources.extractArticle(sourceVersionId, userId, role);
        if (!result) throw new WorkflowStepFailure("NOT_FOUND", "Không tìm thấy nguồn");
        if (result === "forbidden") throw new WorkflowStepFailure("FORBIDDEN", "Không có quyền truy cập nguồn");
        if (result === "invalid_type") throw new WorkflowStepFailure("VALIDATION_FAILED", "Loại nguồn không hỗ trợ trích xuất");
        if ("extractFailed" in result) throw new WorkflowStepFailure(result.extractFailed === "ssrf_blocked" ? "SSRF_BLOCKED" : "PROVIDER_UNAVAILABLE", `Trích xuất nguồn thất bại: ${result.extractFailed}`);
        return result;
      });
    }

    // --- 2. script generation (real content provider call) — reused on retry ---
    // A retried run (status reset back to `draft` after `needs_input`/`blocked_provider`/`failed`,
    // manual or automatic) re-enters this pipeline from step 1 every time - see this file's own
    // header comment on why it does not resume mid-pipeline. Without this check, retrying a run
    // that already failed at a LATER step (voice/media/render) would regenerate an entirely new
    // script with different `sceneId`s, which would (a) pay for a redundant LLM call and (b) defeat
    // the media step's own existing-asset check below and the voice check just after it, since both
    // key off the specific `SceneDraftVersion` ids this approved script fixes.
    const existingApproved = await this.recordStep(run, "reuse_or_generate_script", null, async () => {
      const outcome = await this.scriptVersions.getApprovedForSource(sourceVersionId, userId, role);
      if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
      return outcome.data;
    });
    // VE2E-38/40/31: the run's persisted intake setting (legacy null -> auto), resolved against the
    // intake target duration - used both for the visualPlan the content call writes and for the
    // media plan's segment count, so a retry that reuses the approved script plans the same count.
    const backgroundSegmentRange = resolveBackgroundSegmentRange(readBackgroundSegmentsSetting(run.backgroundSegments), profile.durationSec);
    let approved = existingApproved;
    // VE2E-54: narration budget (targetChars + scene range) from the intake target, calibrated on this voice's history.
    const resolvedBudget = await this.resolveNarrationBudget(profile.durationSec, profile.locale, voiceConfig.voiceId, voiceConfig.modelId);
    const { calibrationSource } = resolvedBudget;
    // An Orshot page template carries one scene per page: ask the script for at most that many scenes (fewer is fine).
    const pinnedSnapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: renderConfig.templateSnapshotId }, select: { modifications: true } });
    const pageCap = orshotMaxScenes((Array.isArray(pinnedSnapshot?.modifications) ? pinnedSnapshot.modifications : []) as unknown as AutoTemplateSlot[]);
    const durationBudget = pageCap === null ? resolvedBudget.budget : { ...resolvedBudget.budget, sceneCount: { min: Math.min(resolvedBudget.budget.sceneCount.min, pageCap), max: Math.min(resolvedBudget.budget.sceneCount.max, pageCap) } };
    // A previously approved script with more scenes than the fixed-page template has pages cannot be rendered: generate a new one (capped).
    if (approved && pageCap !== null && approved.scenes.length > pageCap) approved = null;
    // A retried run reuses its approved script; one whose narration is far outside the duration budget (e.g. 40 s of voice for 78 s) is replaced too.
    if (approved && process.env.SCRIPT_LENGTH_CORRECTION !== "0" && narrationLengthCorrection(durationBudget, approved.scenes.map((scene: { narration?: string }) => scene.narration ?? "")) !== null) approved = null;
    if (!approved) {
      await this.setStatus(run.id, "scripting");
      // The scene count asked for never exceeds the template's page count (the profile default of 14 contradicted a 10-page template).
      const direction = buildAutoDirection(profile.locale, profile.durationSec, pageCap === null ? profile.sceneCount : Math.min(profile.sceneCount, pageCap));
      const generation = await this.recordStep(
        run,
        "generate_script",
        { role: "content", operation: "generate_script", providerAccountId: contentConfig.providerAccountId },
        () => this.limited("content", async () => {
          const outcome = await this.scriptGeneration.generate(sourceVersionId, userId, role, {
            providerAccountId: contentConfig.providerAccountId,
            language: profile.locale,
            direction,
            ...(backgroundSegmentRange ? { backgroundSegmentRange } : {}),
            durationBudget,
          });
          if (!outcome) throw new WorkflowStepFailure("NOT_FOUND", "Không tìm thấy nguồn");
          if (outcome === "forbidden") throw new WorkflowStepFailure("FORBIDDEN", "Không có quyền truy cập nguồn");
          if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
          // VE2E-54: a draft far outside the narration budget (e.g. 28 s of voice for a 78 s target) is regenerated ONCE with an explicit
          // length correction; the closer of the two drafts is kept. A failed second call keeps the first draft (never fails the run).
          const narrations = (outcome.response.draft.scenes ?? []).map((scene: { narration?: string }) => scene.narration ?? "");
          const correction = narrationLengthCorrection(durationBudget, narrations);
          const capped = (response: typeof outcome.response): typeof outcome.response => (pageCap === null ? response : { ...response, draft: mergeScenesToCap(response.draft, pageCap) });
          const charsOf = (response: typeof outcome.response) => (response.draft.scenes ?? []).reduce((sum: number, scene: { narration?: string }) => sum + (scene.narration ?? "").trim().length, 0);
          // VE2E-54: a draft far outside the narration budget (e.g. 40 s of voice for a 78 s target) is regenerated with an explicit length
          // correction, up to twice (the 2nd attempt names the shortfall of the 1st); the draft closest to the target is kept. A failed
          // call keeps the best draft so far (never fails the run). SCRIPT_LENGTH_CORRECTION=0 disables it.
          let best = outcome.response;
          if (process.env.SCRIPT_LENGTH_CORRECTION !== "0") {
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const correction = narrationLengthCorrection(durationBudget, (best.draft.scenes ?? []).map((scene: { narration?: string }) => scene.narration ?? ""));
              if (!correction) break;
              try {
                const next = await this.scriptGeneration.generate(sourceVersionId, userId, role, {
                  providerAccountId: contentConfig.providerAccountId,
                  language: profile.locale,
                  direction: `${direction}

${correction.direction}`,
                  ...(backgroundSegmentRange ? { backgroundSegmentRange } : {}),
                  durationBudget,
                });
                if (!next || next === "forbidden" || !next.ok) break;
                if (Math.abs(charsOf(next.response) - durationBudget.targetChars) < Math.abs(correction.totalChars - durationBudget.targetChars)) best = next.response;
                else break;
              } catch {
                break;
              }
            }
          }
          return capped(best);
        }),
      );

      // VE2E-50: keep WHY the visualPlan is missing/invalid (and whether the strict schema was rejected) instead of a silent null.
      if (generation.diagnostics) await this.saveStepDiagnostics(run, "script_visual_plan_diagnostics", generation.diagnostics);
      await this.appendRunUsage(run, {
        step: "generate_script",
        kind: "content",
        provider: generation.providerPin.provider,
        modelId: generation.providerPin.modelId,
        inputTokens: generation.providerPin.usage?.inputTokens ?? null,
        outputTokens: generation.providerPin.usage?.outputTokens ?? null,
        costAmount: generation.providerPin.usage?.costAmount ?? null,
        costCurrency: generation.providerPin.usage?.costCurrency ?? null,
        at: new Date().toISOString(),
      });

      // --- 3. persist + zero-human-gate auto-approve (§4: "Auto mode không dùng awaiting_* làm human gate") ---
      await this.setStatus(run.id, "awaiting_script_approval");
      const persisted = await this.recordStep(run, "persist_script_version", null, async () => {
        const outcome = await this.scriptVersions.create(sourceVersionId, userId, role, { draft: generation.draft, providerPin: generation.providerPin });
        if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
        return outcome.data;
      });
      approved = await this.recordStep(run, "approve_script_version", null, async () => {
        const outcome = await this.scriptVersions.approve(persisted.id, userId, role);
        if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
        return outcome.data;
      });
    }
    if (approved.scenes.length === 0) throw new WorkflowStepFailure("VALIDATION_FAILED", "Script được duyệt không có scene nào");
    // Orshot cannot expand a fixed page template. Check before paid voice/media work.
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: renderConfig.templateSnapshotId } });
    if (!snapshot) throw new WorkflowStepFailure("NOT_FOUND", "Không tìm thấy template snapshot đã pin trong renderConfig");
    if (snapshot.providerAccountId !== renderConfig.providerAccountId) throw new WorkflowStepFailure("VALIDATION_FAILED", "renderConfig.providerAccountId không khớp với template snapshot đã pin");
    const slots = (Array.isArray(snapshot.modifications) ? snapshot.modifications : []) as unknown as AutoTemplateSlot[];
    const orshotPages = orshotPageCount(slots);
    // Fewer scenes than pages is fine (only pages 1..N render); more cannot be added to a fixed template.
    if (orshotPages !== null && approved.scenes.length > orshotPages) {
      throw new WorkflowStepFailure("VALIDATION_FAILED", `Template Orshot chỉ có ${orshotPages} page nhưng kịch bản có ${approved.scenes.length} cảnh. Rút xuống tối đa ${orshotPages} cảnh hoặc chọn template nhiều page hơn.`);
    }

    // --- 4+5. VE2E-133: voice (TTS) and media sourcing run IN PARALLEL ---
    // Sourcing starts right after the approved script, planned with `durationHintMs` (or the real duration of an audio reused on
    // a retry); only the range cut (`buildBindings`) needs the real voice duration. When the real durations change the segment
    // plan or a source can no longer cover its scenes, `reconcileSourcedSegments` keeps every source already found and only the
    // new/split segments are searched. Neither branch is ever abandoned: both settle before the first failure is rethrown, so a
    // failing branch never leaves the other one running unobserved (and TTS is never paid twice: finished audio stays `current`).
    const orderedScenes = [...approved.scenes].sort((a, b) => a.orderIndex - b.orderIndex);
    // Template-aware sourcing: a template can mix image and video scene slots. Each scene is sourced as the kind its slot expects
    // (images from Pinterest, videos from TikTok), so a segment never mixes kinds. A video-only template stays video-only.
    const kindSnapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: renderConfig.templateSnapshotId }, select: { modifications: true } });
    const kindSlots = (Array.isArray(kindSnapshot?.modifications) ? kindSnapshot.modifications : []) as unknown as Array<{ kind?: string }>;
    const kindByScene = deriveSceneVisualKinds(kindSlots.map((slot) => String(slot.kind ?? "")), orderedScenes.map((scene) => scene.sceneId));
    // Fail fast (before any paid work) when the chosen media account is not usable.
    const mediaCheck = await this.mediaPlans.checkMediaSourcesEnabled(userId, role, mediaConfig.providerAccountId);
    if (!mediaCheck.ok) throw new WorkflowStepFailure(mediaCheck.code, mediaCheck.message);

    await this.setStatus(run.id, "voice_generating");
    const audioByScene = new Map<string, { audioVersionId: string; mediaAssetVersionId: string; subtitleVersionId: string | null; durationMs: number | null }>();
    // Scene ids are stable across a retry (see step 2's own reasoning) - a `current` AudioVersion already tied to this exact
    // SceneDraftVersion id reflects a real, already-paid-for prior success, safe to reuse without a real ElevenLabs call.
    type ExistingAudio = { id: string; mediaAssetVersionId: string; durationMs: number | null; subtitleVersions?: Array<{ id: string }> };
    const existingAudioByScene = new Map<string, ExistingAudio>();
    await Promise.all(approved.scenes.map(async (scene) => {
      const row = await this.prisma.audioVersion.findFirst({
        where: { sceneDraftVersionId: scene.id, status: "current" },
        orderBy: { version: "desc" },
        include: { subtitleVersions: { where: { status: "current" }, orderBy: { version: "desc" }, take: 1 } },
      });
      if (row) existingAudioByScene.set(scene.id, row as unknown as ExistingAudio);
    }));
    const buildPlanScript = (voiceMsOf: (sceneId: string) => number | null): MediaPlanScript => ({
      language: approved.language,
      scenes: orderedScenes.map((scene) => ({
        sceneId: scene.sceneId,
        narration: scene.narration,
        screenText: scene.screenText,
        visualQuery: scene.visualQuery,
        durationHintMs: scene.durationHintMs,
        voiceDurationMs: voiceMsOf(scene.sceneId),
      })),
      visualPlan: approved.visualPlan ?? null,
    });
    const planFor = (script: MediaPlanScript): PlannedSegment[] => {
      let segments = this.mediaPlans.planSegments(script, backgroundSegmentRange);
      if (kindByScene) {
        const durations = new Map(script.scenes.map((scene) => [scene.sceneId, Math.max(1, Math.round(scene.voiceDurationMs ?? scene.durationHintMs))] as const));
        segments = splitSegmentsByVisualKind(segments, kindByScene, durations);
      }
      return segments;
    };
    const earlyVoiceMs = new Map(orderedScenes.flatMap((scene) => {
      const ms = existingAudioByScene.get(scene.id)?.durationMs;
      return typeof ms === "number" ? [[scene.sceneId, ms] as const] : [];
    }));
    const earlyScript = buildPlanScript((sceneId) => earlyVoiceMs.get(sceneId) ?? null);
    const earlyPlan = planFor(earlyScript);
    const ledger = new SegmentSourceLedger();
    // VE2E-51: segments are sourced with bounded concurrency (3) inside MediaPlanService; each import keeps its own StepRun.
    const runSourcing = (script: MediaPlanScript, segments: PlannedSegment[], allowSecondSource = true, reservedSegmentIds: readonly string[] = []) =>
      this.mediaPlans.sourceSegments(run.projectId, userId, role, {
        providerAccountId: mediaConfig.providerAccountId,
        script,
        segments,
        ledger,
        allowSecondSource,
        reservedSegmentIds,
        // VE2E-130: the media step never fails the job; a segment without a source falls down L4 -> L5 -> L6 (quality_degraded).
        guaranteeSource: true,
        // VE2E-50: ONE keyword-extraction call for all segments that need a new source, before the concurrent sourcing starts.
        beforeSourcing: (pending) => this.extractMissingKeywords(run, { userId, role, contentAccountId: contentConfig.providerAccountId, script, title: approved.title, segments: pending }),
        runImport: (segment, task) =>
          this.recordStep(
            run,
            `import_media_${segment.segmentId}`,
            { role: "visual", operation: "media_search", providerAccountId: mediaConfig.providerAccountId },
            async () => {
              const outcome = await task();
              if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
              return outcome;
            },
          ),
      });

    // VE2E-134b: early clip cut (fire-and-forget; EARLY_CLIP_CUT=0 disables). Ranges come from buildBindings, i.e. the same ones the render step asks for.
    const earlyCuts = new EarlyClipCutter(this.clipDerivatives, run.projectId, userId, undefined, (message) => console.warn(message));
    const launchEarlyCuts = (script: MediaPlanScript, sourcedNow: SourcedSegment[]) => {
      if (!this.clipDerivatives || !earlyClipCutEnabled()) return;
      try {
        const placeholders = new Set(sourcedNow.filter((piece) => piece.source?.placeholder).flatMap((piece) => piece.segment.sceneIds));
        earlyCuts.launch(this.mediaPlans.buildBindings(script, sourcedNow).scenes, placeholders);
      } catch (error) {
        console.warn(`[early-clip-cut] skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const branchMs: { voice?: number; media?: number } = {};
    const phaseStartedAt = Date.now();
    // VE2E-61: scenes are voiced with bounded parallelism (WORKFLOW_VOICE_PARALLELISM) AND the shared per-provider limiter
    // (elevenlabs), so many runs together never exceed the provider's concurrent-request ceiling. Each scene's work is
    // independent; the per-scene StepRun key stays `generate_audio_<sceneId>`.
    const runVoice = async () => {
      const voiced = await mapBounded(approved!.scenes, this.voiceParallelism, async (scene) => {
        const existingAudio = existingAudioByScene.get(scene.id);
        if (existingAudio) {
          return {
            sceneId: scene.sceneId,
            value: {
              audioVersionId: existingAudio.id,
              mediaAssetVersionId: existingAudio.mediaAssetVersionId,
              subtitleVersionId: existingAudio.subtitleVersions?.[0]?.id ?? null,
              durationMs: typeof existingAudio.durationMs === "number" ? existingAudio.durationMs : null,
            },
          };
        }
        const audio = await this.recordStep(
          run,
          `generate_audio_${scene.sceneId}`,
          { role: "tts", operation: "generate_voice", providerAccountId: voiceConfig.providerAccountId },
          () => this.limited("elevenlabs", async () => {
            const outcome = await this.audioVersions.generateForWorkflowRun(scene.id, userId, role, {
              providerAccountId: voiceConfig.providerAccountId,
              voiceId: voiceConfig.voiceId!,
              ...(voiceConfig.modelId ? { modelId: voiceConfig.modelId } : {}),
            });
            if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
            return outcome.data;
          }),
        );
        return {
          sceneId: scene.sceneId,
          value: {
            audioVersionId: audio.id,
            mediaAssetVersionId: audio.mediaAssetVersionId,
            subtitleVersionId: audio.subtitleVersion?.id ?? null,
            durationMs: typeof audio.durationMs === "number" ? audio.durationMs : null,
          },
        };
      });
      for (const entry of voiced) audioByScene.set(entry.sceneId, entry.value);
      branchMs.voice = Date.now() - phaseStartedAt;
    };
    // Both branches get their own wall-clock StepRun (`voice_generation`, `media_sourcing`) next to the per-scene/per-segment ones,
    // so `report:failures` (VE2E-84) sees the two parallel durations (their max is the real critical path, not their sum).
    const sourcingBranch = this.settle(this.recordStep(run, "media_sourcing", null, async () => {
      // Early pass: durations are hints unless every scene's audio already exists (retry); the post-TTS reconcile pass splits uncovered tails.
      const result = await runSourcing(earlyScript, earlyPlan, earlyVoiceMs.size === orderedScenes.length);
      launchEarlyCuts(earlyScript, result.sourced);
      branchMs.media = Date.now() - phaseStartedAt;
      return result;
    }));
    const voiceBranch = this.settle(this.recordStep(run, "voice_generation", null, runVoice));
    const [voiceResult, sourcingResult] = await Promise.all([voiceBranch, sourcingBranch]);
    if (!voiceResult.ok) throw voiceResult.error;
    if (!sourcingResult.ok) throw sourcingResult.error;
    const earlySourcing = sourcingResult.value;

    // VE2E-54: real total of all scene voice durations vs the intake target (+-10 s). No correction loop yet:
    // outside the band the run continues but is flagged `duration_out_of_band` with the real total (never silent).
    const knownDurations = approved.scenes.map((scene) => audioByScene.get(scene.sceneId)?.durationMs).filter((ms): ms is number => typeof ms === "number");
    const band = checkDurationBand({ targetSec: profile.durationSec, totalMs: knownDurations.reduce((sum, ms) => sum + ms, 0) });
    await this.saveDurationBudget(run, {
      ...band,
      sceneCount: approved.scenes.length,
      unknownScenes: approved.scenes.length - knownDurations.length,
      flag: band.inBand ? null : "duration_out_of_band",
      charsPerSecond: durationBudget.charsPerSecond,
      calibrationSource,
    });
    // Subtitle is auto-derived synchronously from real alignment inside generateForWorkflowRun (VE2E-03) — no separate "aligning" work, kept as a status marker for progress readability only.
    await this.setStatus(run.id, "aligning");
    await this.setStatus(run.id, "media_preparing");

    // Real durations -> final segment plan. Everything already sourced is kept; only new/split/uncovered segments are searched.
    const planScript = buildPlanScript((sceneId) => audioByScene.get(sceneId)?.durationMs ?? null);
    const plannedSegments = planFor(planScript);
    if (earlySourcing.failure) {
      // VE2E-48: keep the per-segment sourcing decisions made before the failing segment visible on the run.
      await this.saveMediaSourcingDiagnostics(run, this.mediaPlans.buildBindings(earlyScript, earlySourcing.sourced).diagnostics, earlySourcing.apifyUsage, earlySourcing.visionUsage);
      throw earlySourcing.failure.error;
    }
    const durationByScene = new Map(planScript.scenes.map((scene) => [scene.sceneId, Math.max(1, Math.round(scene.voiceDurationMs ?? scene.durationHintMs))] as const));
    const reconciled = reconcileSourcedSegments({ finalSegments: plannedSegments, early: earlySourcing.sourced, durationOf: (sceneId) => durationByScene.get(sceneId) ?? 1 });
    let secondPass: Awaited<ReturnType<typeof runSourcing>> | null = null;
    if (reconciled.toSource.length > 0) secondPass = await runSourcing(planScript, reconciled.toSource, true, reconciled.reused.map((piece) => piece.segment.segmentId));
    const sourced: SourcedSegment[] = ensureUniqueSegmentIds(orderByScript([...reconciled.reused, ...(secondPass?.sourced ?? [])], orderedScenes.map((scene) => scene.sceneId)));
    // Final (real voice duration) ranges: only scenes whose range drifted > 300 ms from the early request are cut again.
    if (!secondPass?.failure && !earlySourcing.failure) launchEarlyCuts(planScript, sourced);
    const sourcing = {
      sourced,
      failure: secondPass?.failure ?? null,
      apifyUsage: mergeApifyUsage(earlySourcing.apifyUsage, secondPass?.apifyUsage ?? null),
      visionUsage: mergeVisionUsage(earlySourcing.visionUsage, secondPass?.visionUsage ?? null),
    };
    await this.saveStepDiagnostics(run, "parallel_pipeline_diagnostics", {
      earlySegments: earlyPlan.length,
      finalSegments: plannedSegments.length,
      structureChanged: !sameSegmentStructure(earlyPlan, plannedSegments),
      reconcile: reconciled.stats,
      researchedSegmentIds: reconciled.toSource.map((segment) => segment.segmentId),
      branchMs,
      earlyUsedRealVoiceMs: earlyVoiceMs.size,
    });
    await this.saveResumeDiagnostics(run, {
      reusedScript: existingApproved !== null && approved === existingApproved,
      reusedAudioScenes: existingAudioByScene.size,
      totalScenes: approved.scenes.length,
      reusedMediaSegments: sourced.filter((piece) => piece.source?.sourcing === "reused").length,
      totalMediaSegments: sourced.length,
    });
    if (sourcing.failure) {
      await this.saveMediaSourcingDiagnostics(run, this.mediaPlans.buildBindings(planScript, sourced).diagnostics, sourcing.apifyUsage, sourcing.visionUsage);
      throw sourcing.failure.error;
    }
    const mediaPlan = this.mediaPlans.buildBindings(planScript, sourced);
    await this.saveMediaSourcingDiagnostics(run, mediaPlan.diagnostics, sourcing.apifyUsage, sourcing.visionUsage);
    if (sourcing.visionUsage) {
      await this.appendRunUsage(run, { step: "vision_moderation", kind: "content", provider: null, modelId: sourcing.visionUsage.modelId, inputTokens: null, outputTokens: null, costAmount: null, costCurrency: null, calls: sourcing.visionUsage.calls, at: new Date().toISOString() });
    }
    // VE2E-85: pre-render quality gate (pure computation, no provider call). Auto-corrects the plan in place; a missing source never stops the job.
    await this.applyQualityGate(run, {
      mediaPlan,
      sourced,
      narrationByScene: new Map(approved.scenes.map((scene: { sceneId: string; narration?: string }) => [scene.sceneId, scene.narration ?? ""] as const)),
      durationByScene,
      targetSec: profile.durationSec,
    });
    const mediaByScene = new Map(mediaPlan.scenes.filter((scene) => scene.mediaAssetVersionId && scene.mediaKind).map((scene) => [scene.sceneId, { id: scene.mediaAssetVersionId!, kind: scene.mediaKind! }]));
    const planByScene = new Map(mediaPlan.scenes.map((scene) => [scene.sceneId, scene]));

    // --- 6. timeline: preflight the positional slot mapping, then persist it as an auto-approved TimelineVersion (VE2E-42) ---
    await this.setStatus(run.id, "editing");
    const sceneMedia: AutoSceneMedia[] = approved.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      orderIndex: scene.orderIndex,
      // narration (not the separately LLM-authored screenText) - see AutoSceneMedia.displayText's
      // own doc comment: the on-screen caption must be exactly what the voice says, word for word.
      displayText: scene.narration,
      tagText: scene.screenText,
      visualMediaAssetVersionId: mediaByScene.get(scene.sceneId)?.id ?? null,
      visualKind: mediaByScene.get(scene.sceneId)?.kind ?? null,
      audioMediaAssetVersionId: audioByScene.get(scene.sceneId)?.mediaAssetVersionId ?? null,
    }));
    const extraText = { title: approved.title, caption: approved.caption };
    // Preflight only (no DB/provider effect): fail fast as needs_input with the exact missing keys
    // before anything is persisted, same message/classification as before VE2E-42.
    // Only the fixed-slot path needs every slot filled. When the scene count differs from the template's scene slots, or an
    // image scene (e.g. Pinterest) has no image slot, the render step composes the scenes with the template-scaled generator
    // (VE2E-52) instead, so a positional "missing Video-N" check would wrongly reject a run that renders fine.
    const fixedSlots = fixedSlotPathApplies({
      slotCount: countTemplateSceneSlots(snapshot.rawTemplate),
      includedSceneCount: sceneMedia.length,
      imageSceneCount: sceneMedia.filter((scene) => scene.visualKind === "image").length,
      templateImageSlots: slots.filter((slot) => slot.kind === "image").length,
    });
    const built = fixedSlots || orshotPages !== null ? buildAutoRenderAssignments(slots, sceneMedia, extraText) : ({ ok: true, assignments: [] } as const);
    if (!built.ok) {
      const detail = built.reason === "missing_required_slot" ? `Template thiếu asset cho modification bắt buộc: ${built.missingKeys.join(", ")}` : "Không có scene nào để dựng timeline";
      throw new WorkflowStepFailure("VALIDATION_FAILED", detail);
    }
    // VE2E-42 (CR-JP-ONESHOT-MEDIA §8): Auto's bindings become a real, auto-approved TimelineVersion
    // so "Mở trong Studio" on this run shows exactly what was rendered, and the render goes through
    // the one shared timeline->render step Studio also uses. The persisted content reproduces the
    // assignments above: each scene's caption is pinned to its narration via `screenTextOverride`
    // (the same word-for-word rule `AutoSceneMedia.displayText` documents), and title/caption fill
    // the leftover text slots via `optionValues`. VE2E-31: segments + per-scene source ranges from
    // the media plan are persisted too (ranges are cut into derivatives at render time, VE2E-37).
    const timeline = await this.recordStep(run, "persist_timeline_version", null, async () => {
      const outcome = await this.timelines.persistApprovedForWorkflowRun(run.id, run.projectId, userId, role, {
        templateSnapshotId: renderConfig.templateSnapshotId,
        scenes: orderedScenes.map((scene) => ({
          sceneId: scene.sceneId,
          mediaAssetVersionId: mediaByScene.get(scene.sceneId)?.id ?? null,
          audioVersionId: audioByScene.get(scene.sceneId)?.audioVersionId ?? null,
          subtitleVersionId: audioByScene.get(scene.sceneId)?.subtitleVersionId ?? null,
          screenTextOverride: scene.narration.trim() || null,
          segmentId: planByScene.get(scene.sceneId)?.segmentId ?? null,
          sourceStartMs: planByScene.get(scene.sceneId)?.sourceStartMs ?? null,
          sourceDurationMs: planByScene.get(scene.sceneId)?.sourceDurationMs ?? null,
        })),
        segments: mediaPlan.segments,
        // Only the telop recipe has a headline slot; other internal recipes must not receive an unknown option key.
        optionValues: snapshot.engine === "lyonix" ? (approved.title?.trim() && slots.some((slot) => slot.key === "headline") ? { headline: approved.title.trim() } : {}) : buildAutoTimelineOptionValues(slots, sceneMedia, extraText),
      });
      if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
      return outcome.data;
    });
    await this.setStatus(run.id, "ready_to_render");

    // --- 7. submit render from the approved timeline (idempotent by run.requestFingerprint) ---
    await this.setStatus(run.id, "render_queued");
    await this.recordStep(
      run,
      "submit_render",
      { role: "render", operation: "render_submit", providerAccountId: renderConfig.providerAccountId },
      () => this.limited("creatomate", async () => {
        const outcome = await this.renderJobs.enqueueTimelineRender(
          run.projectId,
          timeline.id,
          userId,
          role,
          {
            providerAccountId: renderConfig.providerAccountId,
            idempotencyKey: run.requestFingerprint,
            ...(renderConfig.outputFormat ? { outputFormat: renderConfig.outputFormat } : {}),
            ...(renderConfig.orshot ? { orshot: renderConfig.orshot } : {}),
          },
          "template",
          run.id,
        );
        if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
        return outcome.data;
      }),
    );
    // Terminal progress (completed/failed) is applied by `reconcileRenders()` as the linked RenderJob advances — never here, since Creatomate rendering is inherently async (webhook/poll).
  }

  /** Advances every run parked on `render_queued|rendering|verifying` by polling its linked `RenderJob` (best-effort, same monotonic-guarded reconcile the render-jobs poll fallback already uses). */
  private async reconcileRenders(): Promise<boolean> {
    const runs = await this.prisma.workflowRun.findMany({ where: { mode: "auto", status: { in: ["render_queued", "rendering", "verifying"] } } });
    if (runs.length === 0) return false;
    for (const run of runs) {
      const job = await this.prisma.renderJob.findFirst({ where: { workflowRunId: run.id }, orderBy: { createdAt: "desc" } });
      if (!job) continue;
      const reconciled = await this.renderJobs.reconcileOne(job.id);
      if (!reconciled.ok) continue;
      const jobRow = reconciled.data;
      if (jobRow.status === "completed" && run.status !== "completed") {
        await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: "completed" } });
      } else if (jobRow.status === "failed" && run.status !== "failed") {
        const lastError = jobRow.lastError ?? { code: "PROVIDER_SUBMIT_UNKNOWN", message: "Creatomate render thất bại" };
        await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: "failed", lastError: { ...lastError, stepKey: "render" } } });
      } else if (jobRow.status === "rendering" && run.status !== "rendering") {
        await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: "rendering" } });
      } else if (jobRow.status === "verifying" && run.status !== "verifying") {
        await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: "verifying" } });
      }
      // accepted/queued/blocked_provider/reconciling on the render job -> no WorkflowRun status change yet, keep polling.
    }
    return true;
  }
}
