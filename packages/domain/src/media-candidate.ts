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
export type MediaRightsStatus = "cleared" | "unclear" | "restricted" | "owner_accepted_risk";

/**
 * True when a candidate's rights state permits unattended (Auto) use. `owner_accepted_risk`
 * (VE2E-34, DEC-2026-09-29-JP-ONESHOT-MEDIA #1) is distinct from `cleared` but the project owner
 * has accepted the risk for allowlisted Apify social sources; it never means the rights are clear.
 */
export const isRightsUsableForAuto = (status: MediaRightsStatus): boolean => status === "cleared" || status === "owner_accepted_risk";

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
  /** VE2E-34: audit trail for candidates fetched through an allowlisted Apify Actor (platform, pinned Actor id/version, run, source page, author, fetch time). */
  apify?: ApifyCandidateProvenance;
};

export type ApifyCandidateProvenance = {
  platform: string;
  actorId: string;
  actorVersion: string;
  actorRole: "primary" | "backup";
  runId: string | null;
  datasetItemIndex: number;
  sourceUrl: string | null;
  author: string | null;
  fetchedAt: string;
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
/**
 * Person-focused shot description, asked in the SAME moderation call only when the video's subject is one person. It describes the
 * frame (how many people, close-up, overlaid text, logo, news / quote card) and never who is shown: identity comes from metadata.
 */
export type VisionShotFindings = {
  peopleCount: number;
  /** One person is the clear main subject with the face visible (close-up / portrait / medium shot). */
  closeUp: boolean;
  textCoverage: "none" | "little" | "heavy";
  /** Broadcaster / publisher / channel logo or watermark visible. */
  logo: boolean;
  /** News / article screenshot, TV news graphic, headline or quote card, meme, collage - not real footage / a photo of a person. */
  newsCard: boolean;
};

/**
 * Person-focused identity verdict, asked in the SAME moderation call only when the video is about one person: is the media the target
 * person (`match`), visibly someone else (`different_person`), nobody (`no_person`) or not decidable (`uncertain`)? Metadata / hashtags
 * alone never conclude the identity; a refusal or malformed answer leaves this absent (metadata ranking decides).
 */
export type VisionIdentityFindings = {
  match: "match" | "different_person" | "uncertain" | "no_person";
  confidence: number;
};

export type VisionFindings = {
  decision: VisionModerationDecision;
  confidence: number;
  reasonCodes: string[];
  sceneBeatRelevance: number | null;
  safetyFindings: string[];
  /** Present only when the person-focused shot fields were asked (and answered). */
  shot?: VisionShotFindings;
  /** Present only when the target-person identity check was asked (and answered). */
  identity?: VisionIdentityFindings;
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
