import { applyVisionFindings, decideVisionModeration, rankMediaCandidates, type MediaCandidate, type SceneBrief } from "@lyonix/domain";
import { moderateSceneCandidate, type LiveContentKind, type SceneModerationOutcome, type VisionModerationFrame, type VisionModerationSceneContext } from "@lyonix/providers";

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

/**
 * VE2E-57 x VE2E-56 hook. `ProviderAccountsService` gains these two methods in VE2E-56; both are optional here so this
 * code works (always available) before that lands.
 */
export type ModelAvailability = {
  getModelAvailability?: (accountId: string, modelId: string) => Promise<{ available: boolean; retryAt: Date | null }>;
  markModelLimited?: (accountId: string, modelId: string, retryAfterMs?: number, reason?: string) => Promise<unknown> | unknown;
};

export type VisionSkipReason = "vision_skipped_budget" | "vision_skipped_quota";

/** Pick only from models discovered for this key. The explicit account setting wins; otherwise prefer a cheap
 * alternative to the script model. The real adapter still probes vision capability before moderation. */
export const resolveVisionModel = (pinnedModel: string, availableModels: readonly string[] = [], configuredModel?: string | null, env: NodeJS.ProcessEnv = process.env): string => {
  const candidates = [...new Set(availableModels.length ? availableModels : [pinnedModel])];
  if (configuredModel && candidates.includes(configuredModel)) return configuredModel;
  const preferred = (env.VISION_MODEL_PREFERENCE ?? "").split(",").map((m) => m.trim()).find((m) => candidates.includes(m));
  if (preferred) return preferred;
  const cheap = candidates.filter((m) => m !== pinnedModel && /flash-lite|4o-mini|4\.1-mini|grok-4-fast|grok-3-mini/i.test(m));
  return cheap[0] ?? candidates.find((m) => m !== pinnedModel) ?? pinnedModel;
};

export class VisionBudget {
  readonly maxCalls: number;
  readonly maxCandidatesPerSegment: number;
  /** Provider requests spent by vision (a capability probe counts as one, the moderation request as one). */
  calls = 0;
  moderated = 0;
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
  account: { id: string; provider: string; apiKey: string; model: string };
  sceneContext: VisionModerationSceneContext;
  /** Returns the cover frame for a candidate, or null when it cannot be fetched (candidate keeps its metadata score). */
  fetchFrame: (candidate: MediaCandidate) => Promise<VisionModerationFrame | null>;
  availability?: ModelAvailability | null;
  /** Test seam; defaults to the real adapter. */
  moderate?: typeof moderateSceneCandidate;
};

/**
 * Moderates at most `maxCandidatesPerSegment` top-ranked candidates, stops at the first ACCEPTED one, never exceeds the
 * job's call cap, and skips (recording the reason) when the model is unavailable or was rate limited. Requests carry one
 * frame each: the adapter returns a single verdict per call, so per-candidate verdicts cannot be separated from a batch.
 */
export async function moderatePoolWithBudget(input: BudgetedModerationInput): Promise<MediaCandidate[]> {
  const { pool, budget, account } = input;
  const moderate = input.moderate ?? moderateSceneCandidate;
  const modelKey = `${account.id}:${account.model}`;
  budget.setModel(account.model);
  const order = rankMediaCandidates(pool, input.brief, { usedExternalIds: input.usedExternalIds }).slice(0, budget.maxCandidatesPerSegment).map((r) => r.candidate.candidateId);
  const byId = new Map(pool.map((c) => [c.candidateId, c] as const));
  for (const candidateId of order) {
    const candidate = byId.get(candidateId);
    if (!candidate?.previewUrl) continue;
    if (budget.isLimited(modelKey)) {
      budget.note(input.scopeKey, "vision_skipped_quota");
      break;
    }
    const availability = input.availability;
    if (availability && typeof availability.getModelAvailability === "function") {
      try {
        const state = await availability.getModelAvailability(account.id, account.model);
        if (!state.available) {
          budget.markLimited(modelKey);
          budget.note(input.scopeKey, "vision_skipped_quota");
          break;
        }
      } catch {
        // Availability is advisory; a failing lookup never blocks moderation.
      }
    }
    const cachedCapability = budget.capabilityFor(modelKey);
    const cost = cachedCapability ? 1 : 2; // no fresh capability evidence => the adapter also sends a probe request
    if (budget.calls + cost > budget.maxCalls) {
      budget.note(input.scopeKey, "vision_skipped_budget");
      break;
    }
    const frame = await input.fetchFrame(candidate);
    if (!frame) continue;
    if (!budget.reserve(cost)) {
      budget.note(input.scopeKey, "vision_skipped_budget");
      break;
    }
    let outcome: SceneModerationOutcome;
    try {
      outcome = await moderate({
        kind: account.provider as LiveContentKind,
        apiKey: account.apiKey,
        modelId: account.model,
        operation: "image_moderation",
        sceneContext: input.sceneContext,
        frames: [frame],
        ...(cachedCapability ? { capabilityEvidence: { verifiedAt: cachedCapability } } : {}),
      });
    } catch {
      // A transport failure still consumed the reservation; keep the candidate's metadata evidence.
      continue;
    }
    budget.moderated += 1;
    if (outcome.capabilityVerifiedAt) budget.setCapability(modelKey, outcome.capabilityVerifiedAt);
    if (outcome.failureCode === "PROVIDER_RATE_LIMITED" || outcome.failureCode === "PROVIDER_QUOTA_EXHAUSTED") {
      budget.markLimited(modelKey);
      budget.note(input.scopeKey, "vision_skipped_quota");
      if (availability && typeof availability.markModelLimited === "function") {
        try {
          await availability.markModelLimited(account.id, account.model, outcome.retryAfterMs, `vision:${outcome.failureCode}`);
        } catch {
          // best effort
        }
      }
      break;
    }
    const findings = decideVisionModeration({ raw: outcome.raw, provider: account.provider, model: account.model, operation: "image_moderation", evidenceRefs: outcome.evidenceRefs });
    byId.set(candidateId, applyVisionFindings(candidate, findings));
    if (findings.decision === "accepted") break;
  }
  return pool.map((c) => byId.get(c.candidateId) ?? c);
}
