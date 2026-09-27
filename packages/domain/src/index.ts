/**
 * NOTE for browser consumers (e.g. `apps/web`): this barrel re-exports every domain module,
 * including `audio-format.ts` which uses `node:crypto`. Vite/Rollup fails hard (not just a
 * tree-shaking miss) if that module is anywhere in the import graph, even unused, because
 * `createHash` cannot be resolved against the browser externalization shim. Browser code should
 * import the specific subpath it needs instead of this barrel - see the `"./media-ranking"` and
 * `"./media-candidate"` entries in `package.json#exports` (used by
 * `apps/web/src/studio/media-selection.ts`) rather than adding a new bare `@lyonix/domain` import
 * from browser code.
 */
export type Id = string;

export type Money = {
  amount: string;
  currency: string;
};

export type GrantSet = {
  teamIds: Id[];
  projectIds: Id[];
  channelIds: Id[];
};

export {
  isPrivateOrBlockedIpv4,
  isPrivateOrBlockedIpv6,
  isBlockedHostname,
  validateSourceUrl,
  validateResolvedAddress,
  type SsrfCheckResult,
} from "./ssrf.js";
export {
  isSafeRelativePath,
  isSafeSegmentName,
  resolveWithinRoot,
} from "./path-safety.js";
export {
  computeExpiresAt,
  isExpired,
  isRetentionExempt,
  WORKING_RETENTION_DAYS,
  type RetentionClass,
} from "./media-retention.js";
export {
  canAccessProject,
  canManageProject,
  canWriteProjectResource,
  type ProjectGrantSet,
  type Role as ProjectRole,
} from "./project-access.js";
export {
  assertMutable,
  isApproved,
  nextVersionNumber,
  type ImmutabilityCheck,
  type VersionedRecord,
} from "./version-immutability.js";
export {
  findDuplicateReusableAsset,
  isSha256Hex,
  type ExistingAsset,
} from "./media-checksum.js";
export {
  sniffAudioFormat,
  isSupportedTtsAudioMimeType,
  validateGeneratedAudio,
  type SniffedAudioFormat,
  type GeneratedAudioValidationInput,
  type GeneratedAudioValidationResult,
} from "./audio-format.js";
export {
  VOICE_CONSENT_STATEMENT_VERSION,
  buildVoiceConsentStatement,
  validateConsentEvidence,
  assertConsentEvidence,
  type ConsentEvidence,
  type ConsentValidationResult,
} from "./voice-consent.js";
export {
  renderJobStatuses,
  isTerminalRenderStatus,
  nextRenderJobStatus,
  type RenderJobStatus,
} from "./render-status.js";
export {
  buildCaptionSegmentsFromAlignment,
  type CharacterAlignment,
  type CaptionSegment,
  type CaptionSegmentationOptions,
} from "./caption-segmentation.js";
export {
  buildAutoRenderAssignments,
  type AutoModificationKind,
  type AutoTemplateSlot,
  type AutoSceneMedia,
  type AutoRenderAssignment,
  type AutoRenderAssignmentsResult,
} from "./auto-render-assignments.js";
export {
  visionModerationDecisions,
  type MediaCandidateType,
  type MediaAccessMethod,
  type MediaRightsStatus,
  type MediaAttribution,
  type MediaProvenance,
  type MediaCapabilityEvidence,
  type VisionModerationDecision,
  type VisionFindings,
  type MediaCandidateEligibility,
  type MediaCandidate,
} from "./media-candidate.js";
export {
  narrativeBeats,
  tokenizeSceneText,
  deriveNarrativeBeat,
  deriveSceneBrief,
  detectScriptLanguageHeuristic,
  buildBoundedQueryVariants,
  rankMediaCandidates,
  decideMediaSelection,
  canAutoApplyMediaCandidate,
  applyVisionFindings,
  normalizeSceneBriefForCache,
  buildMediaCandidateCacheKey,
  MAX_QUERY_VARIANTS,
  MEDIA_RANKING_POLICY_VERSION,
  MEDIA_RANKING_WEIGHTS,
  MEDIA_RELEVANCE_THRESHOLD,
  type NarrativeBeat,
  type SceneBriefSourceScene,
  type SceneBriefSourceScript,
  type SceneBrief,
  type SceneBriefOptions,
  type MediaRankingOptions,
  type RankedMediaCandidate,
  type MediaSelectionAbstentionReason,
  type MediaSelectionDecision,
  type MediaSelectionOptions,
} from "./media-ranking.js";
export {
  decideVisionModeration,
  buildModerationAuditEntry,
  VISION_MODERATION_POLICY_VERSION,
  VISION_HIGH_CONFIDENCE_THRESHOLD,
  type VisionModerationRawResult,
  type VisionModerationPolicyInput,
  type ModerationAuditEntry,
} from "./vision-moderation-policy.js";
