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
 * Bounded retry / cost ceiling (known, documented scope limits — see VE2E-06 handoff
 * for the full reasoning, not repeated here): a transient provider failure re-queues
 * the ENTIRE run (status back to `draft`, `attempts` incremented) rather than resuming
 * from the failed step, bounded by `AutomationProfileVersion.retryPolicy.maxAttempts`
 * (default 2). `costCeiling` is persisted/exposed on the profile but not enforced
 * against real spend in this pass: no adapter in this codebase currently returns
 * actual per-call cost/usage (`packages/providers`' `UsageRecord`/`CostEstimate`
 * types are defined but never populated by any live adapter — confirmed by
 * repo-wide grep before writing this) — wiring real per-provider cost/usage into a
 * `CostLedger` is a separate, adapter-level scope change, not invented here.
 */
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import type { WorkflowRun as WorkflowRunRow } from "@lyonix/db";
import type { MediaPlanApifyUsage, MediaPlanSegmentDiagnostics } from "@lyonix/contracts";
import {
  buildAutoRenderAssignments,
  buildAutoTimelineOptionValues,
  readBackgroundSegmentsSetting,
  resolveBackgroundSegmentRange,
  type PlannedSegment,
  type AutoSceneMedia,
  type AutoTemplateSlot,
} from "@lyonix/domain";
import { AudioVersionsService } from "./audio-versions.service.js";
import { MediaPlanService, SegmentSourceLedger, applyExtractedKeywords, segmentNarration, segmentsNeedingKeywords, type MediaPlanScript, type SourcedSegment } from "./media-plan.service.js";
import { PrismaService } from "./prisma.service.js";
import { RenderJobsService } from "./render-jobs.service.js";
import { ScriptGenerationService } from "./script-generation.service.js";
import { ScriptVersionsService } from "./script-versions.service.js";
import { SourcesService } from "./sources.service.js";
import { TimelineVersionsService } from "./timeline-versions.service.js";

// --- AutomationProfileVersion JSON config parsing (shared with video-productions.service.ts) ---

export type ContentAccountRef = { providerAccountId: string };
export type VoiceAccountRef = { providerAccountId: string; voiceId?: string; modelId?: string };
export type RenderAccountRef = { providerAccountId: string; templateSnapshotId: string; outputFormat?: "mp4" | "mov" | "gif" };

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
  return {
    providerAccountId: record.providerAccountId,
    templateSnapshotId: record.templateSnapshotId,
    ...(outputFormat === "mp4" || outputFormat === "mov" || outputFormat === "gif" ? { outputFormat } : {}),
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
  at: string;
};

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
  ) {}

  /** One tick: claim+run at most one draft Auto run, then reconcile every run waiting on a render. Returns whether anything happened (used by the worker loop to decide whether to sleep). */
  async processNext(): Promise<boolean> {
    const processedDraft = await this.processOneDraft();
    const reconciledAny = await this.reconcileRenders();
    return processedDraft || reconciledAny;
  }

  private async processOneDraft(): Promise<boolean> {
    const candidate = await this.prisma.workflowRun.findFirst({ where: { mode: "auto", status: "draft" }, orderBy: { createdAt: "asc" } });
    if (!candidate) return false;
    const claimed = await this.prisma.workflowRun.updateMany({ where: { id: candidate.id, status: "draft" }, data: { status: "source_ready" } });
    if (claimed.count !== 1) return true; // another worker tick/replica won the claim race
    const run: WorkflowRunRow = { ...candidate, status: "source_ready" };
    try {
      await this.runPipeline(run);
    } catch (error) {
      await this.handleFailure(run, error);
    }
    return true;
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
      if (operationId) await this.prisma.providerOperation.update({ where: { id: operationId }, data: { status: "succeeded" } });
      return value;
    } catch (error) {
      const code = error instanceof WorkflowStepFailure ? error.code : "PROVIDER_UNAVAILABLE";
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
  private saveMediaSourcingDiagnostics(run: WorkflowRunRow, segments: MediaPlanSegmentDiagnostics[], apifyUsage: MediaPlanApifyUsage | null = null): Promise<void> {
    return this.saveStepDiagnostics(run, "media_plan_diagnostics", { segments, ...(apifyUsage ? { apifyUsage } : {}) });
  }

  /**
   * VE2E-50/54: run-level usage ledger (`run_usage` StepRun outputRef): one entry per paid call
   * (script generation, keyword extraction, script regeneration, TTS) so the spend of a run,
   * including the bounded corrections, is countable in one place. Best-effort.
   */
  private async appendRunUsage(run: WorkflowRunRow, entry: RunUsageEntry): Promise<void> {
    try {
      const existing = await this.prisma.stepRun.findUnique({ where: { workflowRunId_stepKey_attempt: { workflowRunId: run.id, stepKey: "run_usage", attempt: run.attempts } } });
      const previous = (existing?.outputRef as { entries?: RunUsageEntry[] } | null)?.entries;
      await this.saveStepDiagnostics(run, "run_usage", { entries: [...(Array.isArray(previous) ? previous : []), entry] });
    } catch {
      // Best-effort.
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
    if (needing.length === 0) return;
    if (!(await this.mediaPlans.apifyAvailable(ctx.userId, ctx.role))) return;
    const requested = needing.map((segment) => segment.segmentId);
    try {
      const outcome = await this.recordStep(
        run,
        "extract_keywords",
        { role: "content", operation: "extract_keywords", providerAccountId: ctx.contentAccountId },
        async () => {
          const result = await this.scriptGeneration.extractSegmentKeywords(ctx.userId, ctx.role, {
            providerAccountId: ctx.contentAccountId,
            language: ctx.script.language,
            title: ctx.title,
            segments: needing.map((segment) => ({ segmentId: segment.segmentId, narration: segmentNarration(ctx.script, segment) })),
          });
          if (!result.ok) throw new WorkflowStepFailure(result.code, result.message);
          return result;
        },
      );
      applyExtractedKeywords(ctx.segments, outcome.keywords);
      await this.appendRunUsage(run, { step: "extract_keywords", kind: "content", provider: outcome.provider, modelId: outcome.modelId, inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, costAmount: outcome.usage.costAmount, costCurrency: outcome.usage.costCurrency, at: new Date().toISOString() });
      await this.saveStepDiagnostics(run, "keyword_extraction_diagnostics", { requested, extracted: Object.keys(outcome.keywords), rejected: outcome.rejectedSegmentIds, modelId: outcome.modelId });
    } catch (error) {
      await this.saveStepDiagnostics(run, "keyword_extraction_diagnostics", { requested, extracted: [], failed: error instanceof Error ? error.message.slice(0, 200) : "error", reason: "no_ja_keywords" });
    }
  }

  private async handleFailure(run: WorkflowRunRow, error: unknown): Promise<void> {
    const code = error instanceof WorkflowStepFailure ? error.code : "PROVIDER_UNAVAILABLE";
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
    if (!approved) {
      await this.setStatus(run.id, "scripting");
      const direction = buildAutoDirection(profile.locale, profile.durationSec, profile.sceneCount);
      const generation = await this.recordStep(
        run,
        "generate_script",
        { role: "content", operation: "generate_script", providerAccountId: contentConfig.providerAccountId },
        async () => {
          const outcome = await this.scriptGeneration.generate(sourceVersionId, userId, role, {
            providerAccountId: contentConfig.providerAccountId,
            language: profile.locale,
            direction,
            ...(backgroundSegmentRange ? { backgroundSegmentRange } : {}),
          });
          if (!outcome) throw new WorkflowStepFailure("NOT_FOUND", "Không tìm thấy nguồn");
          if (outcome === "forbidden") throw new WorkflowStepFailure("FORBIDDEN", "Không có quyền truy cập nguồn");
          if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
          return outcome.response;
        },
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

    // --- 4. voice generation + alignment/subtitle per scene — reused on retry ---
    await this.setStatus(run.id, "voice_generating");
    const audioByScene = new Map<string, { audioVersionId: string; mediaAssetVersionId: string; subtitleVersionId: string | null; durationMs: number | null }>();
    for (const scene of approved.scenes) {
      // Scene ids are stable across a retry (see step 2's own reasoning) - a `current` AudioVersion
      // already tied to this exact SceneDraftVersion id reflects a real, already-paid-for prior
      // success, safe to reuse without a real ElevenLabs call.
      const existingAudio = await this.prisma.audioVersion.findFirst({
        where: { sceneDraftVersionId: scene.id, status: "current" },
        orderBy: { version: "desc" },
        include: { subtitleVersions: { where: { status: "current" }, orderBy: { version: "desc" }, take: 1 } },
      });
      if (existingAudio) {
        audioByScene.set(scene.sceneId, {
          audioVersionId: existingAudio.id,
          mediaAssetVersionId: existingAudio.mediaAssetVersionId,
          subtitleVersionId: existingAudio.subtitleVersions?.[0]?.id ?? null,
          durationMs: typeof existingAudio.durationMs === "number" ? existingAudio.durationMs : null,
        });
        continue;
      }
      const audio = await this.recordStep(
        run,
        `generate_audio_${scene.sceneId}`,
        { role: "tts", operation: "generate_voice", providerAccountId: voiceConfig.providerAccountId },
        async () => {
          const outcome = await this.audioVersions.generateForWorkflowRun(scene.id, userId, role, {
            providerAccountId: voiceConfig.providerAccountId,
            voiceId: voiceConfig.voiceId!,
            ...(voiceConfig.modelId ? { modelId: voiceConfig.modelId } : {}),
          });
          if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
          return outcome.data;
        },
      );
      audioByScene.set(scene.sceneId, {
        audioVersionId: audio.id,
        mediaAssetVersionId: audio.mediaAssetVersionId,
        subtitleVersionId: audio.subtitleVersion?.id ?? null,
        durationMs: typeof audio.durationMs === "number" ? audio.durationMs : null,
      });
    }
    // Subtitle is auto-derived synchronously from real alignment inside generateForWorkflowRun (VE2E-03) — no separate "aligning" work, kept as a status marker for progress readability only.
    await this.setStatus(run.id, "aligning");

    // --- 5. media: VE2E-31 one-shot background plan (MediaPlanService, shared with Studio) ---
    // Consecutive scenes are grouped into background segments (script visualPlan or deterministic
    // fallback, count from the run's VE2E-40 setting); each segment gets ONE source (reused from the
    // project library on retry, else searched by keywords.en through the Pexels rank/moderation/
    // rights gate) and a new segment never reuses an earlier segment's source. Replaces the old
    // per-scene `usedExternalIds` hard block. Unattended Auto stops at the first unsourceable
    // segment (needs_input), same as the old per-scene abstention.
    await this.setStatus(run.id, "media_preparing");
    const orderedScenes = [...approved.scenes].sort((a, b) => a.orderIndex - b.orderIndex);
    const planScript: MediaPlanScript = {
      language: approved.language,
      scenes: orderedScenes.map((scene) => ({
        sceneId: scene.sceneId,
        narration: scene.narration,
        screenText: scene.screenText,
        visualQuery: scene.visualQuery,
        durationHintMs: scene.durationHintMs,
        voiceDurationMs: audioByScene.get(scene.sceneId)?.durationMs ?? null,
      })),
      visualPlan: approved.visualPlan ?? null,
    };
    const ledger = new SegmentSourceLedger();
    // VE2E-51: segments are sourced with bounded concurrency (3) inside MediaPlanService; each import keeps its own StepRun.
    const sourcing = await this.mediaPlans.sourceSegments(run.projectId, userId, role, {
      providerAccountId: mediaConfig.providerAccountId,
      script: planScript,
      segments: this.mediaPlans.planSegments(planScript, backgroundSegmentRange),
      ledger,
      stopOnFailure: true,
      // VE2E-50: ONE keyword-extraction call for all segments that need a new source, before the concurrent sourcing starts.
      beforeSourcing: (pending) => this.extractMissingKeywords(run, { userId, role, contentAccountId: contentConfig.providerAccountId, script: planScript, title: approved.title, segments: pending }),
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
    const sourced: SourcedSegment[] = sourcing.sourced;
    if (sourcing.failure) {
      // VE2E-48: keep the per-segment sourcing decisions made before the failing segment visible on the run.
      await this.saveMediaSourcingDiagnostics(run, this.mediaPlans.buildBindings(planScript, sourced).diagnostics, sourcing.apifyUsage);
      throw sourcing.failure.error;
    }
    const mediaPlan = this.mediaPlans.buildBindings(planScript, sourced);
    await this.saveMediaSourcingDiagnostics(run, mediaPlan.diagnostics, sourcing.apifyUsage);
    const mediaByScene = new Map(mediaPlan.scenes.filter((scene) => scene.mediaAssetVersionId && scene.mediaKind).map((scene) => [scene.sceneId, { id: scene.mediaAssetVersionId!, kind: scene.mediaKind! }]));
    const planByScene = new Map(mediaPlan.scenes.map((scene) => [scene.sceneId, scene]));

    // --- 6. timeline: preflight the positional slot mapping, then persist it as an auto-approved TimelineVersion (VE2E-42) ---
    await this.setStatus(run.id, "editing");
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: renderConfig.templateSnapshotId } });
    if (!snapshot) throw new WorkflowStepFailure("NOT_FOUND", "Không tìm thấy template snapshot đã pin trong renderConfig");
    if (snapshot.providerAccountId !== renderConfig.providerAccountId) throw new WorkflowStepFailure("VALIDATION_FAILED", "renderConfig.providerAccountId không khớp với template snapshot đã pin");
    const slots = (Array.isArray(snapshot.modifications) ? snapshot.modifications : []) as unknown as AutoTemplateSlot[];
    const sceneMedia: AutoSceneMedia[] = approved.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      orderIndex: scene.orderIndex,
      // narration (not the separately LLM-authored screenText) - see AutoSceneMedia.displayText's
      // own doc comment: the on-screen caption must be exactly what the voice says, word for word.
      displayText: scene.narration,
      visualMediaAssetVersionId: mediaByScene.get(scene.sceneId)?.id ?? null,
      visualKind: mediaByScene.get(scene.sceneId)?.kind ?? null,
      audioMediaAssetVersionId: audioByScene.get(scene.sceneId)?.mediaAssetVersionId ?? null,
    }));
    const extraText = { title: approved.title, caption: approved.caption };
    // Preflight only (no DB/provider effect): fail fast as needs_input with the exact missing keys
    // before anything is persisted, same message/classification as before VE2E-42.
    const built = buildAutoRenderAssignments(slots, sceneMedia, extraText);
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
        optionValues: buildAutoTimelineOptionValues(slots, sceneMedia, extraText),
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
      async () => {
        const outcome = await this.renderJobs.enqueueTimelineRender(
          run.projectId,
          timeline.id,
          userId,
          role,
          {
            providerAccountId: renderConfig.providerAccountId,
            idempotencyKey: run.requestFingerprint,
            ...(renderConfig.outputFormat ? { outputFormat: renderConfig.outputFormat } : {}),
          },
          "template",
          run.id,
        );
        if (!outcome.ok) throw new WorkflowStepFailure(outcome.code, outcome.message);
        return outcome.data;
      },
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
