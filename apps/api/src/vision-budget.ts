import { applyVisionFindings, decideVisionModeration, rankMediaCandidates, type MediaCandidate, type SceneBrief } from "@lyonix/domain";
import { ProviderError, VISION_BATCH_MAX, VISION_BATCH_MIN, moderateSceneCandidate, moderateSceneCandidatesBatch, type LiveContentKind, type SceneBatchOutcome, type SceneModerationOutcome, type VisionModerationFrame, type VisionModerationSceneContext } from "@lyonix/providers";
import { callContentWithModelFailover, type ModelFailoverAccounts } from "./content-model-failover.js";

/**
 * VE2E-57: per-job vision-moderation budget. One instance per workflow run / media-plan request (created in
 * `MediaPlanService.sourceSegments`), shared by every segment (Apify) and every Pexels fallback of that job.
 * Vision is best-effort evidence: when the budget is spent or the model is cooling down, moderation is skipped and the
 * metadata-only ranking + VE2E-51 filters decide (never a failed run).
 */

export const DEFAULT_VISION_MAX_CALLS_PER_JOB = 6;
export const DEFAULT_VISION_MAX_CANDIDATES_PER_SEGMENT = 2;

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && raw !== undefined && raw.trim() !== "" ? Math.floor(n) : fallback;
};

export const visionMaxCallsPerJob = (env: NodeJS.ProcessEnv = process.env) => positiveInt(env.VISION_MAX_CALLS_PER_JOB, DEFAULT_VISION_MAX_CALLS_PER_JOB);
export const visionMaxCandidatesPerSegment = (env: NodeJS.ProcessEnv = process.env) => positiveInt(env.VISION_MAX_CANDIDATES_PER_SEGMENT, DEFAULT_VISION_MAX_CANDIDATES_PER_SEGMENT);

/** VE2E-131: cover images judged per vision request (env `VISION_BATCH_SIZE`, clamped to 4..6). */
export const visionBatchSize = (env: NodeJS.ProcessEnv = process.env) => Math.min(VISION_BATCH_MAX, Math.max(VISION_BATCH_MIN, positiveInt(env.VISION_BATCH_SIZE, 5)));

export type ModelAvailability = ModelFailoverAccounts;

export type VisionSkipReason = "vision_skipped_budget" | "vision_skipped_quota";

/** Pick only from models discovered for this key. The explicit account setting wins; otherwise prefer a cheap
 * alternative to the script model. The real adapter still probes vision capability before moderation. */
export const resolveVisionModels = (pinnedModel: string, availableModels: readonly string[] = [], configuredModel?: string | null, env: NodeJS.ProcessEnv = process.env): string[] => {
  const candidates = [...new Set(availableModels.length ? availableModels : [pinnedModel])];
  const preferred = (env.VISION_MODEL_PREFERENCE ?? "").split(",").map((m) => m.trim()).filter((m) => candidates.includes(m));
  const cheap = candidates.filter((m) => m !== pinnedModel && /flash-lite|4o-mini|4\.1-mini|grok-4-fast|grok-3-mini/i.test(m));
  return [...new Set([...(configuredModel && candidates.includes(configuredModel) ? [configuredModel] : []), ...preferred, ...cheap, ...candidates.filter((m) => m !== pinnedModel), pinnedModel])];
};
export const resolveVisionModel = (pinnedModel: string, availableModels: readonly string[] = [], configuredModel?: string | null, env: NodeJS.ProcessEnv = process.env): string =>
  resolveVisionModels(pinnedModel, availableModels, configuredModel, env)[0] ?? pinnedModel;

export class VisionBudget {
  readonly maxCalls: number;
  readonly maxCandidatesPerSegment: number;
  /** Provider requests spent by vision (a capability probe counts as one, the moderation request as one). */
  calls = 0;
  moderated = 0;
  /** VE2E-131: Auto (unattended) job. When vision could not run, the metadata ranking decides instead of abstaining. Set by the job context. */
  unattended = false;
  /** scopeKey (scene id) -> why vision was skipped for it. */
  readonly skips = new Map<string, VisionSkipReason>();
  private readonly capability = new Map<string, string>();
  private readonly limitedModels = new Set<string>();
  private modelId: string | null = null;

  constructor(opts: { maxCalls?: number; maxCandidatesPerSegment?: number } = {}) {
    this.maxCalls = opts.maxCalls ?? visionMaxCallsPerJob();
    this.maxCandidatesPerSegment = opts.maxCandidatesPerSegment ?? visionMaxCandidatesPerSegment();
  }

  get skippedSegments(): number {
    return this.skips.size;
  }

  usage(): { calls: number; moderated: number; skippedSegments: number; maxCalls: number; modelId: string | null } | null {
    if (this.calls === 0 && this.skips.size === 0) return null;
    return { calls: this.calls, moderated: this.moderated, skippedSegments: this.skips.size, maxCalls: this.maxCalls, modelId: this.modelId };
  }

  skipReasonFor(scopeKey: string): VisionSkipReason | null {
    return this.skips.get(scopeKey) ?? null;
  }

  /** @internal */
  note(scopeKey: string, reason: VisionSkipReason) {
    if (!this.skips.has(scopeKey)) this.skips.set(scopeKey, reason);
  }

  /** @internal */
  capabilityFor(key: string) {
    return this.capability.get(key) ?? null;
  }
  /** @internal */
  setCapability(key: string, at: string) {
    this.capability.set(key, at);
  }
  /** @internal */
  isLimited(key: string) {
    return this.limitedModels.has(key);
  }
  /** @internal */
  markLimited(key: string) {
    this.limitedModels.add(key);
  }
  /** @internal */
  setModel(id: string) {
    this.modelId = id;
  }

  /** Reserve synchronously before the first provider request so concurrent segments share a hard cap. */
  reserve(cost: number): boolean {
    if (this.calls + cost > this.maxCalls) return false;
    this.calls += cost;
    return true;
  }
}

export type BudgetedModerationInput = {
  pool: MediaCandidate[];
  brief: SceneBrief;
  usedExternalIds: ReadonlySet<string>;
  /** Scene/segment key the skip reason is recorded under. */
  scopeKey: string;
  budget: VisionBudget;
  account: { id: string; provider: string; apiKey: string; model: string; models?: readonly string[] };
  sceneContext: VisionModerationSceneContext;
  /** Returns the cover frame for a candidate, or null when it cannot be fetched (candidate keeps its metadata score). */
  fetchFrame?: (candidate: MediaCandidate) => Promise<VisionModerationFrame | null>;
  /** VE2E-30: several frames of ONE video (extracted by the media worker); takes precedence over `fetchFrame`. One verdict per call. */
  fetchFrames?: (candidate: MediaCandidate) => Promise<VisionModerationFrame[]>;
  availability: ModelAvailability;
  /** Test seam; defaults to the real adapter. Passing it forces the legacy one-request-per-candidate path. */
  moderate?: typeof moderateSceneCandidate;
  /** VE2E-131 test seam for the batched cover pass (default: the real adapter). */
  moderateBatch?: typeof moderateSceneCandidatesBatch;
};

/**
 * Moderates at most `maxCandidatesPerSegment` top-ranked candidates, stops at the first ACCEPTED one, never exceeds the
 * job's call cap, and skips (recording the reason) when the model is unavailable or was rate limited. Requests carry one
 * frame each: the adapter returns a single verdict per call, so per-candidate verdicts cannot be separated from a batch.
 */
export async function moderatePoolWithBudget(input: BudgetedModerationInput): Promise<MediaCandidate[]> {
  const { pool, budget, account } = input;
  const moderate = input.moderate ?? moderateSceneCandidate;
  budget.setModel(account.model);
  if (!input.moderate && !input.fetchFrames && input.fetchFrame) return moderateCoversInBatch(input);
  const order = rankMediaCandidates(pool, input.brief, { usedExternalIds: input.usedExternalIds }).slice(0, budget.maxCandidatesPerSegment).map((r) => r.candidate.candidateId);
  const byId = new Map(pool.map((c) => [c.candidateId, c] as const));
  for (const candidateId of order) {
    const candidate = byId.get(candidateId);
    if (!candidate?.previewUrl) continue;
    if (budget.calls >= budget.maxCalls) {
      budget.note(input.scopeKey, "vision_skipped_budget");
      break;
    }
    const frames = input.fetchFrames ? await input.fetchFrames(candidate) : await input.fetchFrame?.(candidate).then((frame) => (frame ? [frame] : []));
    if (!frames || frames.length === 0) continue;
    const selected = await callContentWithModelFailover(input.availability, account.id, account.models ?? [account.model], async (modelId) => {
      const modelKey = `${account.id}:${modelId}`;
      const cachedCapability = budget.capabilityFor(modelKey);
      const cost = cachedCapability ? 1 : 2;
      if (!budget.reserve(cost)) throw new VisionBudgetExhausted();
      const outcome: SceneModerationOutcome = await moderate({
        kind: account.provider as LiveContentKind,
        apiKey: account.apiKey,
        modelId,
        operation: "image_moderation",
        sceneContext: input.sceneContext,
        frames,
        ...(cachedCapability ? { capabilityEvidence: { verifiedAt: cachedCapability } } : {}),
      });
      if (outcome.capabilityVerifiedAt) budget.setCapability(modelKey, outcome.capabilityVerifiedAt);
      if (outcome.failureCode) throw new ProviderError(outcome.failureCode, "Vision model unavailable", true, outcome.retryAfterMs, outcome.quotaScope);
      budget.moderated += 1;
      return outcome;
    }, { markCapabilityUnusable: false });
    if (!selected.ok) {
      if (selected.thrown instanceof VisionBudgetExhausted) budget.note(input.scopeKey, "vision_skipped_budget");
      else if (selected.limited.length > 0 || selected.error?.code === "PROVIDER_RATE_LIMITED" || selected.error?.code === "PROVIDER_QUOTA_EXHAUSTED") budget.note(input.scopeKey, "vision_skipped_quota");
      break;
    }
    budget.setModel(selected.modelId);
    const findings = decideVisionModeration({ raw: selected.value.raw, provider: account.provider, model: selected.modelId, operation: "image_moderation", evidenceRefs: selected.value.evidenceRefs });
    byId.set(candidateId, applyVisionFindings(candidate, findings));
    if (findings.decision === "accepted") break;
  }
  return pool.map((c) => byId.get(c.candidateId) ?? c);
}

/**
 * VE2E-131: ONE vision request judges the top 4-6 cover images (8 s deadline inside the adapter). Any failure (quota, rate limit,
 * timeout, malformed answer, exhausted budget) leaves the pool untouched so the metadata ranking decides - vision never blocks a pick.
 * A timeout is reported as `vision_skipped_quota` (model unavailable) to keep the contract's skip-reason union unchanged.
 */
async function moderateCoversInBatch(input: BudgetedModerationInput): Promise<MediaCandidate[]> {
  const { pool, budget, account } = input;
  const moderateBatch = input.moderateBatch ?? moderateSceneCandidatesBatch;
  const order = rankMediaCandidates(pool, input.brief, { usedExternalIds: input.usedExternalIds }).slice(0, visionBatchSize()).map((r) => r.candidate.candidateId);
  const byId = new Map(pool.map((c) => [c.candidateId, c] as const));
  if (budget.calls >= budget.maxCalls) {
    budget.note(input.scopeKey, "vision_skipped_budget");
    return pool;
  }
  const fetched = await Promise.all(order.map(async (id) => {
    const candidate = byId.get(id);
    if (!candidate?.previewUrl) return null;
    const frame = await input.fetchFrame?.(candidate).catch(() => null);
    return frame ? { id, frame } : null;
  }));
  const items = fetched.filter((i): i is { id: string; frame: VisionModerationFrame } => i !== null);
  if (items.length === 0) return pool;
  const selected = await callContentWithModelFailover(input.availability, account.id, account.models ?? [account.model], async (modelId) => {
    const modelKey = `${account.id}:${modelId}`;
    const cachedCapability = budget.capabilityFor(modelKey);
    if (!budget.reserve(cachedCapability ? 1 : 2)) throw new VisionBudgetExhausted();
    const outcome: SceneBatchOutcome = await moderateBatch({
      kind: account.provider as LiveContentKind,
      apiKey: account.apiKey,
      modelId,
      sceneContext: input.sceneContext,
      items,
      ...(cachedCapability ? { capabilityEvidence: { verifiedAt: cachedCapability } } : {}),
    });
    if (outcome.capabilityVerifiedAt) budget.setCapability(modelKey, outcome.capabilityVerifiedAt);
    if (outcome.failureCode) throw new ProviderError(outcome.failureCode, "Vision model unavailable", true, outcome.retryAfterMs, outcome.quotaScope);
    return outcome;
  }, { markCapabilityUnusable: false });
  if (!selected.ok) {
    if (selected.thrown instanceof VisionBudgetExhausted) budget.note(input.scopeKey, "vision_skipped_budget");
    else budget.note(input.scopeKey, "vision_skipped_quota");
    return pool;
  }
  budget.setModel(selected.modelId);
  for (const [candidateId, raw] of selected.value.verdicts) {
    const candidate = byId.get(candidateId);
    if (!candidate) continue;
    budget.moderated += 1;
    const findings = decideVisionModeration({ raw, provider: account.provider, model: selected.modelId, operation: "image_moderation", evidenceRefs: selected.value.evidenceRefs });
    byId.set(candidateId, applyVisionFindings(candidate, findings));
  }
  return pool.map((c) => byId.get(c.candidateId) ?? c);
}

class VisionBudgetExhausted extends Error {}
