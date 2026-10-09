/**
 * VE2E-24: pure decision policy for vision moderation - takes an already-shape-validated raw
 * provider response (or `null` for "no usable response at all": provider error, timeout,
 * unverified/unsupported capability, or a malformed response the providers-layer parser
 * rejected) and returns exactly one of `accepted`/`rejected`/`manual_review`, never a 4th state,
 * with scene-beat relevance kept strictly separate from safety findings (spec §5.1). No network
 * I/O, no provider secret handling - the real call lives in
 * `packages/providers/src/vision-moderation.ts`; this file only decides what the result means.
 *
 * No Jev/TypeSafe anywhere in this system (owner decision VE2E-16, 2026-09-27) - this policy
 * only ever consumes a `packages/providers` content-provider vision call.
 */
import type { VisionFindings, VisionIdentityFindings, VisionModerationDecision, VisionShotFindings } from "./media-candidate.js";

export type VisionModerationRawResult = {
  safetyFlag: boolean;
  safetyCategories: readonly string[];
  /** 0..1, independent of `safetyFlag`. */
  sceneBeatRelevance: number;
  /** 0..1 confidence in the whole assessment. */
  confidence: number;
  notes: string;
  /** Person-focused shot description (only when it was asked); copied onto the findings, never part of the safety decision. */
  shot?: VisionShotFindings;
  /** Target-person identity verdict (only when it was asked); copied onto the findings, never part of the safety decision. */
  identity?: VisionIdentityFindings;
};

export type VisionModerationPolicyInput = {
  /** `null` = no usable response (provider error/timeout/unsupported capability/malformed shape) - always fails closed to `manual_review`, never treated as safe-by-default. */
  raw: VisionModerationRawResult | null;
  provider: string;
  model: string;
  operation: string;
  /** Non-secret, non-raw-payload references only (e.g. provider request id, sampled frame timestamps) - never the raw image/prompt (spec §5.1 telemetry rule). */
  evidenceRefs: readonly string[];
  now?: Date;
};

export const VISION_MODERATION_POLICY_VERSION = "vision-moderation-policy.v1";

/**
 * Documented default - no live human-labeled moderation benchmark exists in this sandbox (same
 * honest framing as `MEDIA_RELEVANCE_THRESHOLD` in `media-ranking.ts`). Test/owner must validate
 * and retune this against a real labeled set before trusting it in production (spec §5.1
 * acceptance: "thresholds and category policy are versioned and tested against a human-labeled
 * set").
 */
export const VISION_HIGH_CONFIDENCE_THRESHOLD = 0.75;

/**
 * High-confidence unsafe -> `rejected`. High-confidence safe -> `accepted`. Everything else
 * (low confidence, no usable response at all) -> `manual_review`. This is the exact three-way,
 * fail-closed mapping spec §5.1 requires - there is no code path that returns a 4th value or
 * defaults to `accepted` on missing/ambiguous input.
 */
export function decideVisionModeration(input: VisionModerationPolicyInput): VisionFindings {
  const decidedAt = (input.now ?? new Date()).toISOString();
  const base = {
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    version: VISION_MODERATION_POLICY_VERSION,
    evidenceRefs: [...input.evidenceRefs],
    decidedAt,
  };
  if (!input.raw) {
    return { ...base, decision: "manual_review", confidence: 0, reasonCodes: ["provider_error_unsupported_or_unverified"], sceneBeatRelevance: null, safetyFindings: [] };
  }
  const { raw } = input;
  const shot = { ...(raw.shot ? { shot: { ...raw.shot } } : {}), ...(raw.identity ? { identity: { ...raw.identity } } : {}) };
  if (raw.safetyFlag && raw.confidence >= VISION_HIGH_CONFIDENCE_THRESHOLD) {
    return { ...base, ...shot, decision: "rejected", confidence: raw.confidence, reasonCodes: raw.safetyCategories.length ? [...raw.safetyCategories] : ["safety_flagged"], sceneBeatRelevance: raw.sceneBeatRelevance, safetyFindings: [...raw.safetyCategories] };
  }
  if (!raw.safetyFlag && raw.confidence >= VISION_HIGH_CONFIDENCE_THRESHOLD) {
    return { ...base, ...shot, decision: "accepted", confidence: raw.confidence, reasonCodes: ["safety_clear_high_confidence"], sceneBeatRelevance: raw.sceneBeatRelevance, safetyFindings: [] };
  }
  // Low confidence, or a conflicting/borderline read - never guess between accept/reject.
  return { ...base, ...shot, decision: "manual_review", confidence: raw.confidence, reasonCodes: ["low_confidence_or_conflicting"], sceneBeatRelevance: raw.sceneBeatRelevance, safetyFindings: [...raw.safetyCategories] };
}

// --- reviewer override audit (pure shape only - see file-level limitation note in state.json/handoff: no DB/API/UI persistence wired in this pass) ---

export type ModerationAuditEntry = {
  candidateId: string;
  previousDecision: VisionModerationDecision | null;
  newDecision: VisionModerationDecision;
  reviewerUserId: string;
  reviewedAt: string;
  reasonNote?: string;
};

/**
 * Builds the durable audit record a reviewer override must produce (spec §5.1: "Record reviewer
 * overrides and resulting asset/scene version in the audit trail"). Pure/deterministic - the
 * caller is responsible for actually persisting this entry; no storage adapter exists in this
 * package (domain stays framework-free), and no API/UI route calls this yet in this pass.
 */
export function buildModerationAuditEntry(input: {
  candidateId: string;
  previousDecision: VisionModerationDecision | null;
  newDecision: VisionModerationDecision;
  reviewerUserId: string;
  reasonNote?: string;
  now?: Date;
}): ModerationAuditEntry {
  return {
    candidateId: input.candidateId,
    previousDecision: input.previousDecision,
    newDecision: input.newDecision,
    reviewerUserId: input.reviewerUserId,
    reviewedAt: (input.now ?? new Date()).toISOString(),
    ...(input.reasonNote ? { reasonNote: input.reasonNote } : {}),
  };
}
