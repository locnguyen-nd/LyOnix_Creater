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
  splitIntoSentences,
  type CharacterAlignment,
  type CaptionSegment,
  type CaptionSegmentationOptions,
} from "./caption-segmentation.js";
export {
  buildAutoRenderAssignments,
  buildAutoTimelineOptionValues,
  type AutoModificationKind,
  type AutoTemplateSlot,
  type AutoSceneMedia,
  type AutoRenderAssignment,
  type AutoRenderAssignmentsResult,
} from "./auto-render-assignments.js";
export { orshotIncludePages, orshotMaxScenes, orshotPageCount } from "./orshot-page-slots.js";
export {
  visionModerationDecisions,
  isRightsUsableForAuto,
  type ApifyCandidateProvenance,
  type MediaCandidateType,
  type MediaAccessMethod,
  type MediaRightsStatus,
  type MediaAttribution,
  type MediaProvenance,
  type MediaCapabilityEvidence,
  type VisionModerationDecision,
  type VisionFindings,
  type VisionShotFindings,
  type VisionIdentityFindings,
  type VisionCleanlinessFindings,
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
  isCleanlinessFallback,
  candidateSubjectMatch,
  decideMediaSelection,
  canAutoApplyMediaCandidate,
  applyVisionFindings,
  normalizeSceneBriefForCache,
  buildMediaCandidateCacheKey,
  MAX_QUERY_VARIANTS,
  MEDIA_RANKING_POLICY_VERSION,
  MEDIA_RANKING_WEIGHTS,
  MEDIA_RELEVANCE_THRESHOLD,
  SUBJECT_MATCH_WEIGHT,
  SUBJECT_COHERENCE_WEIGHT,
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
export {
  validateTimelineSegmentStructure,
  normalizeTimelineSegments,
  TIMELINE_SEGMENT_ID_MAX_LENGTH,
  TIMELINE_SEGMENT_SUBJECT_MAX_LENGTH,
  TIMELINE_SEGMENT_PRIORITY_MIN,
  TIMELINE_SEGMENT_PRIORITY_MAX,
  TIMELINE_SOURCE_RANGE_MAX_MS,
  type TimelineSceneRangeLike,
  type TimelineSegmentLike,
  type TimelineStructureResult,
} from "./timeline-segments.js";
export {
  insertScene,
  duplicateScene,
  removeScene,
  restoreScene,
  updateAddedScene,
  splitScene,
  nextAddedSceneId,
  splitNarrationIntoSentences,
  validateTimelineEditState,
  TIMELINE_ADDED_SCENE_ORIGINS,
  TIMELINE_ADDED_SCENE_ID_PREFIX,
  TIMELINE_ADDED_SCENE_ID_MAX_LENGTH,
  TIMELINE_ADDED_SCENE_NARRATION_MAX_LENGTH,
  TIMELINE_ADDED_SCENE_SCREEN_TEXT_MAX_LENGTH,
  TIMELINE_ADDED_SCENE_DURATION_MIN_MS,
  TIMELINE_ADDED_SCENE_DURATION_MAX_MS,
  TIMELINE_ADDED_SCENE_DEFAULT_DURATION_MS,
  TIMELINE_MAX_SCENES,
  type TimelineAddedSceneDef,
  type TimelineAddedSceneOrigin,
  type TimelineEditScene,
  type TimelineEditState,
  type TimelineEditResult,
  type TimelineEditValidationContext,
  type TimelineSceneTextInfo,
  type SplitSceneInput,
} from "./timeline-edit.js";
export {
  parseMediaAssetTransform,
  isValidMediaAssetTransform,
  type MediaTransformRange,
  type MediaAssetTransformValue,
} from "./media-lineage.js";
export {
  parseBackgroundSegmentsSetting,
  readBackgroundSegmentsSetting,
  resolveBackgroundSegmentRange,
  normalizeBackgroundSegmentBounds,
  BACKGROUND_SEGMENT_COUNT_DEFAULT_BOUNDS,
  BACKGROUND_SEGMENT_SHORT_VIDEO_MAX_SEC,
  BACKGROUND_SEGMENT_AUTO_SHORT,
  BACKGROUND_SEGMENT_AUTO_LONG,
  DEFAULT_BACKGROUND_SEGMENTS_SETTING,
  type BackgroundSegmentsSettingValue,
  type BackgroundSegmentCountBounds,
  type BackgroundSegmentRange,
  type BackgroundSegmentsParseResult,
} from "./background-segments.js";
export { deriveSceneVisualKinds, splitSegmentsByVisualKind, computeWindowRangesWithLoopFallback, type VisualKind, type WindowRangePlan } from "./media-plan-kinds.js";
export {
  planBackgroundSegments,
  allocateSubjectShare,
  mainSubjectShare,
  subjectShareTargetFromEnv,
  DEFAULT_SUBJECT_SHARE_TARGET,
  SUBJECT_SHARE_TARGET_MAX,
  type SegmentKeywords,
  type MediaPlanVideoSubject,
  type PlanBackgroundOptions,
  fitSegmentsToRange,
  chooseFallbackSegmentCount,
  groupScenesByDuration,
  computeSegmentSourceRanges,
  computeSocialWindowRanges,
  socialWindowOptionsFromEnv,
  SOCIAL_CLIP_START_GUARD_MS,
  SOCIAL_CLIP_END_GUARD_MS,
  type SocialWindowPlan,
  type SocialWindowOptions,
  MEDIA_PLAN_POLICY_VERSION,
  MEDIA_PLAN_MIN_SEGMENT_MS,
  MEDIA_PLAN_MAX_SEGMENT_MS,
  type MediaPlanScene,
  type MediaPlanVisualSegment,
  type PlannedSegment,
  type SegmentCountRange,
  type SceneSourceRange,
} from "./media-plan.js";

export {
  JAPAN_GEONAMES_ID,
  evaluateSocialCandidate,
  isJapanCountry,
  keywordOverlap,
  matchesSubjectAlias,
  MIN_DURATION_SHARE,
  SUBJECT_ALIAS_BONUS,
  selectSocialCandidates,
  type SocialFilterTier,
  type SocialCandidateSignals,
  type SocialEvaluation,
  type SocialFilterContext,
  type SocialRejectReason,
  type SocialSelection,
} from "./social-candidate-filter.js";
export {
  DEFAULT_DURATION_TOLERANCE_SEC,
  DEFAULT_CHARS_PER_SECOND,
  defaultCharsPerSecond,
  calibrateCharsPerSecond,
  buildNarrationBudget, narrationLengthCorrection,
  checkDurationBand,
  buildDurationBudgetPromptLines,
  type DurationSample,
  type NarrationBudget,
  type DurationBandCheck,
} from "./duration-budget.js";

export {
  runQualityGate,
  qualityGateConfigFromEnv,
  estimateCaptionLines,
  QUALITY_GATE_DEFAULT_REPEAT_WINDOW,
  QUALITY_GATE_DEFAULT_MIN_SHORT_SIDE_PX,
  QUALITY_GATE_MAX_SUBTITLE_LINES,
  type QualityGateScene,
  type QualityGateAsset,
  type QualityGateConfig,
  type QualityGateFix,
  type QualityGateWarning,
  type QualityGateCheck,
  type QualityGateResult,
  type QualityGateFailure,
} from "./quality-gate.js";

export {
  planReframe,
  reframeOptionsFromEnv,
  REFRAME_PLAN_VERSION,
  REFRAME_MAX_ZOOM_DEFAULT,
  REFRAME_ZOOM_STEP_PERMILLE,
  REFRAME_SMOOTHING_MS_DEFAULT,
  REFRAME_MAX_PAN_PCT_PER_SEC_DEFAULT,
  type PixelBox,
  type SubjectTrack,
  type SubjectTrackSample,
  type ExclusionRegion,
  type CropKeyframe,
  type CropPlan,
  type PlanReframeInput,
  type PlanReframeOptions,
} from "./reframe-plan.js";
export * from "./render-plan.js";
export * from "./caption-ass.js";
export * from "./render-router.js";
export * from "./subtitle-edit.js";
export * from "./creation-form.js";
export { mergeScenesToCap } from "./script-scene-cap.js";
export * from "./caption-fonts.js";
export * from "./caption-style-capabilities.js";
export * from "./caption-style.js";
export * from "./caption-presets.js";
export * from "./news.js";
export * from "./url-intake.js";
export * from "./transcript.js";
export {
  MEDIA_SEGMENT_DEADLINE_DEFAULT_MS,
  mediaSegmentDeadlineMs,
  parseSegmentKeywords,
  segmentTierKeywords,
  raceByPriority,
  findFreeWindow,
  kenBurnsFor,
  type ParsedSegmentKeywords,
  type KeywordTier,
  type RaceResult,
  type ClipWindow,
  type FreeWindowClip,
  type FreeWindowPick,
  type KenBurnsPlan,
  type DegradedTier,
} from "./media-ladder.js";
export {
  subjectProfileOf,
  subjectNames,
  anchorKeywordToSubject,
  subjectTierKeywords,
  subjectMatchScore,
  isOffTopic,
  applySubjectToBrief,
  personTargetOfProfile,
  HIGH_PRIORITY_MAX,
  type SubjectProfile,
} from "./subject-filter.js";
export {
  LIBRARY_TAGS_VERSION,
  LIBRARY_REPEAT_DAYS_DEFAULT,
  LIBRARY_REPEAT_VIDEOS_DEFAULT,
  LIBRARY_MIN_SCORE_DEFAULT,
  AUTHOR_REPEAT_PENALTY,
  buildLibraryTags,
  readLibraryTags,
  scoreLibraryMatch,
  shortenCaption,
  extractHashtags,
  libraryMinScoreFromEnv,
  repeatWindowFromEnv,
  recentJobKeys,
  usedInWindow,
  blockedByRepeatWindow,
  type LibraryTags,
  type LibraryUsage,
  type LibraryQuery,
  type RepeatWindow,
  type RepeatCandidate,
  type RepeatGuard,
} from "./media-library.js";
export {
  socialCookiePlatforms,
  isSocialCookiePlatform,
  SOCIAL_COOKIE_DOMAINS,
  MAX_COOKIES_TEXT_BYTES,
  parseSocialCookies,
  socialCookiesExpiringSoon,
  type SocialCookiePlatform,
  type ParsedSocialCookies,
} from "./social-cookies.js";
export { selectSocialSearchItems, type SocialSearchCandidate, type SocialSearchRejectReason, type SocialSearchSelection } from "./social-search-select.js";
export {
  assessMediaCleanliness,
  metadataEditSignals,
  cleanlinessRejectionCounts,
  CLEANLINESS_TEXT_BANDS,
  SMALL_LOGO_MAX_RATIO,
  CLEANLINESS_MIN_BAD_FRAMES,
  PRE_EDITED_MIN_SIGNALS,
  FINISHED_EDIT_MIN_SIGNALS,
  CLEANLINESS_TIER_SCORE,
  CLEANLINESS_TIER_FACTOR,
  CLEANLINESS_FALLBACK_MESSAGE,
  type CleanlinessTier,
  type CleanlinessRejectionReason,
  type EditSignal,
  type MediaCleanliness,
} from "./media-cleanliness.js";
export {
  SUBJECT_KINDS,
  parseSubjectKind,
  stripHonorifics,
  personNameVariants,
  personTargetOf,
  matchPersonIdentity,
  personMetadataFlags,
  scorePersonCandidate,
  personMatchLevelOf,
  personRejectionCounts,
  visionTargetOf,
  parseTargetPersonInput,
  parseTargetPersonSource,
  resolveTargetPerson,
  stripPersonNames,
  assessScriptPersonFocus,
  assessPersonMediaCoverage,
  PERSON_IDENTITY_SCORES,
  PERSON_SCORE_WEIGHTS,
  PERSON_MEDIA_MIN_SHARE,
  PERSON_TIERS,
  PERSON_TIER_BANDS,
  PERSON_VERIFY_MIN_CONFIDENCE,
  METADATA_IDENTITY_CAP,
  TARGET_PERSON_SOURCES,
  TARGET_PERSON_MAX_CHARS,
  SCRIPT_PERSON_MIN_COVERAGE,
  SCRIPT_PERSON_MAX_OFF_TARGET,
  type SubjectKind,
  type PersonTarget,
  type PersonSubjectInput,
  type PersonIdentity,
  type PersonIdentityLevel,
  type PersonMeta,
  type PersonMediaFlag,
  type PersonCandidateScore,
  type PersonMatchLevel,
  type PersonTier,
  type PersonVerificationMethod,
  type PersonRejectionReason,
  type TargetPersonSource,
  type TargetPersonInput,
  type ResolvedTargetPerson,
  type ScriptPersonFocus,
  type ScriptPersonFocusReason,
  type PersonMediaCoverage,
} from "./person-target.js";
