/**
 * VE2E-15a/15b/24 shared contract: the normalized, source-neutral `MediaCandidate` is the
 * parallel-work boundary between scene-beat ranking (VE2E-15a), additional source adapters
 * (VE2E-15b: Pinterest/Google/YouTube), and vision moderation (VE2E-24). Defined once here
 * (framework-free domain logic) and reused by every provider adapter and ranking/moderation
 * caller so there is exactly one candidate shape across the whole media pipeline - see
 * VE2E-PROVIDER-UX.md §5 (third paragraph) for the authoritative field list this type encodes.
 */

/** Photo vs video - the only two media types the current render pipeline (Creatomate slots) accepts. */
export type MediaCandidateType = "photo" | "video";

/**
 * How this candidate's bytes/embed were actually obtained, not assumed. A provider that can
 * only discover/embed content (e.g. YouTube playback embed) is `api_embed` or `discovery_only`
 * and must never be treated as an importable asset by implication (VE2E-15b hard rule).
 */
export type MediaAccessMethod = "api_download" | "api_embed" | "discovery_only";

/**
 * Rights/terms clearance for the *intended use* (importing into a LyOnix project render), not
 * just "the provider let us fetch metadata". Only `cleared` candidates may ever be auto-applied;
 * `unclear`/`restricted` route to Studio human review (VE2E-15a §5, VE2E-15b B12).
 */
export type MediaRightsStatus = "cleared" | "unclear" | "restricted";

export type MediaAttribution = {
  name: string;
  profileUrl?: string | null;
  sourcePageUrl?: string | null;
};

/** Where/how/when this candidate was retrieved - required for later evaluation/audit (VE2E-15a acceptance). */
export type MediaProvenance = {
  query: string;
  providerAccountId: string;
  queriedAt: string;
  /** Ranking/catalog logic version active when this candidate was produced, for cache/evaluation stability. */
  catalogVersion?: string;
};

/**
 * Evidence that the exact account/model/operation used to inspect this candidate (if any) was
 * verified against the real endpoint before being trusted - mirrors the "no static-catalog
 * trust" principle in `packages/providers/src/content-probe.ts`. `null` means no capability
 * probe has been run yet (metadata-only candidate).
 */
export type MediaCapabilityEvidence = {
  provider: string;
  operation: string;
  verifiedAt: string;
} | null;

export const visionModerationDecisions = ["accepted", "rejected", "manual_review"] as const;
export type VisionModerationDecision = (typeof visionModerationDecisions)[number];

/**
 * VE2E-24 output attached to a candidate once vision moderation has run. Scene-beat relevance
 * is kept strictly separate from safety findings (spec §5.1) even though both come from the
 * same call, so a caller can never accidentally treat "looks safe" as "fits the beat" or vice
 * versa. `sceneBeatRelevance` is `null` only when the response was malformed/unusable.
 */
export type VisionFindings = {
  decision: VisionModerationDecision;
  confidence: number;
  reasonCodes: string[];
  sceneBeatRelevance: number | null;
  safetyFindings: string[];
  provider: string;
  model: string;
  operation: string;
  /** Moderation policy/threshold version that produced this decision - see `packages/domain/src/vision-moderation-policy.ts`. */
  version: string;
  /** Non-secret, non-raw-payload references (e.g. request id, sampled frame timestamps) - never the raw image/prompt (spec §5.1 telemetry rule). */
  evidenceRefs: string[];
  decidedAt: string;
};

export type MediaCandidateEligibility = {
  autoEligible: boolean;
  /** Machine-readable reason when `autoEligible` is false (e.g. `"below_relevance_threshold"`, `"rights_unresolved"`, `"discovery_only_no_import_capability"`, `"rejected_by_vision_moderation"`). */
  reason?: string;
};

export type MediaCandidate = {
  /** Normalized cross-provider id: `${source}:${mediaType}:${externalId}`. */
  candidateId: string;
  /** Provider/source name, e.g. `"pexels" | "youtube" | "pinterest"`. Kept as `string`, not a closed union - the contract is source-neutral (VE2E-15a §5). */
  source: string;
  externalId: string;
  mediaType: MediaCandidateType;
  accessMethod: MediaAccessMethod;
  previewUrl: string;
  embedUrl?: string | null;
  /** Only set when this candidate can actually be downloaded/imported (`accessMethod === "api_download"`). */
  importUrl?: string | null;
  durationSeconds?: number | null;
  widthPx?: number | null;
  heightPx?: number | null;
  attribution: MediaAttribution | null;
  provenance: MediaProvenance;
  rightsStatus: MediaRightsStatus;
  capabilityEvidence: MediaCapabilityEvidence;
  /** 0..1 relevance/quality signal derived from metadata only (no vision call) - see `media-ranking.ts`. */
  metadataScore: number;
  /** Optional short text signal available from the source's own metadata (title/alt/tags), used for keyword overlap scoring. Not present for every provider (e.g. Pexels video search has none). */
  descriptorText?: string | null;
  visionFindings: VisionFindings | null;
  /** Final combined 0..1 score after ranking (semantic/visual fit, continuity, quality, cost) - see `rankMediaCandidates`. */
  relevanceScore: number;
  moderationDecision: VisionModerationDecision | null;
  eligibility: MediaCandidateEligibility;
};
