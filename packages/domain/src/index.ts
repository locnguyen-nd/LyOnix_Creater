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
