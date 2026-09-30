export const providerKinds = ["fake", "openai", "gemini", "xai", "elevenlabs", "pexels", "youtube", "pinterest", "apify", "creatomate", "vrew", "capcut"] as const;
export type ProviderKind = (typeof providerKinds)[number];
export const providerRoles = ["content", "tts", "visual", "render"] as const;
export type ProviderRole = (typeof providerRoles)[number];
export type ProviderErrorCode = "PROVIDER_AUTH_INVALID" | "PROVIDER_CAPABILITY_UNAVAILABLE" | "PROVIDER_RATE_LIMITED" | "PROVIDER_QUOTA_EXHAUSTED" | "PROVIDER_SCHEMA_INVALID" | "PROVIDER_CONTENT_REFUSED" | "PROVIDER_TIMEOUT" | "PROVIDER_SUBMIT_UNKNOWN" | "PROVIDER_UNAVAILABLE" | "PROVIDER_NOT_CONFIGURED";

export class ProviderError extends Error {
  /**
   * VE2E-56: for 429/quota errors, how far the limit reaches. `daily` = per-model daily quota (until reset),
   * `minute` = per-model RPM/TPM, `account` = billing/key level (cools the whole account). Absent = unknown.
   */
  constructor(readonly code: ProviderErrorCode, message: string, readonly retryable: boolean, readonly retryAfterMs?: number, readonly quotaScope?: "daily" | "minute" | "account") { super(message); }
}

export type CapabilitySnapshot = { capabilities: readonly string[]; models: readonly string[]; capturedAt: string };
export type QuotaSnapshot = { status: "available" | "unknown" | "exhausted"; remaining: number | null; unit: string | null; capturedAt: string };
export type CostEstimate = { amount: string | null; currency: string | null; unit: string | null };
export type UsageRecord = { inputTokens: number | null; outputTokens: number | null; providerRequestId: string | null; cost: CostEstimate };
export type ProviderConfig = { accountId: string; configVersionId: string; kind: ProviderKind; role: ProviderRole; modelId: string; endpointProfile: string; capabilities: readonly string[] };
export type ValidateConfigInput = Pick<ProviderConfig, "kind" | "role" | "modelId" | "endpointProfile">;
export type ValidationResult = { valid: boolean; capabilities: CapabilitySnapshot; reasonCode?: ProviderErrorCode };
export type AccountInput = { config: ProviderConfig };

export interface ProviderAccountAdapter {
  validateConfig(input: ValidateConfigInput): Promise<ValidationResult>;
  getCapabilities(input: AccountInput): Promise<CapabilitySnapshot>;
  getQuota?(input: AccountInput): Promise<QuotaSnapshot>;
  estimate?(input: AccountInput & { operation: string }): Promise<CostEstimate>;
}

export type JsonSchema = Readonly<Record<string, unknown>>;
export type ContentGenerationInput = AccountInput & { prompt: string; language: "vi" | "en" | "ja" | "ko"; requestFingerprint: string };
export type ContentGenerationResult<T> = { output: T; usage: UsageRecord };
export interface ContentProviderAdapter extends ProviderAccountAdapter { generateStructured<T>(input: ContentGenerationInput, schema: JsonSchema): Promise<ContentGenerationResult<T>>; }

export type RenderSubmission = AccountInput & { productionRequestId: string; timelineVersionId: string; templateVersionId: string; requestFingerprint: string };
export type RenderJobStatus = "accepted" | "queued" | "rendering" | "verifying" | "completed" | "failed" | "cancelled" | "reconciling" | "blocked_provider";
export type RenderJobSnapshot = { externalJobId: string; status: RenderJobStatus; progress: number | null; externalUrl: string | null; errorCode?: ProviderErrorCode };
export interface RenderProviderAdapter extends ProviderAccountAdapter {
  submit(input: RenderSubmission): Promise<RenderJobSnapshot>;
  getJob(input: AccountInput & { externalJobId: string }): Promise<RenderJobSnapshot>;
  normalizeCallback(input: { payload: unknown; signature?: string }): RenderJobSnapshot;
  cancel?(input: AccountInput & { externalJobId: string }): Promise<RenderJobSnapshot>;
}

export type RegisteredProvider = { kind: ProviderKind; role: ProviderRole; adapter: ProviderAccountAdapter; implementationStatus: "fake" | "available" | "blocked" | "post_mvp" };

/**
 * Runtime no-mock invariant (VE2E §5): a `fake` provider adapter must never be
 * registered outside the test process. `nodeEnv` defaults to `process.env.NODE_ENV`
 * so callers do not need to thread it explicitly; tests run with `NODE_ENV=test`
 * (vitest default) and are unaffected.
 */
export const assertRegistrationAllowed = (kind: ProviderKind, nodeEnv: string | undefined = process.env.NODE_ENV) => {
  if (kind === "fake" && nodeEnv !== "test") {
    throw new Error("Fake provider adapters may only be registered when NODE_ENV=test");
  }
};

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private key(kind: ProviderKind, role: ProviderRole) { return `${kind}:${role}`; }
  register(provider: RegisteredProvider) {
    assertRegistrationAllowed(provider.kind);
    const key = this.key(provider.kind, provider.role);
    if (this.providers.has(key)) throw new Error(`Provider already registered: ${key}`);
    this.providers.set(key, provider);
  }
  resolve(kind: ProviderKind, role: ProviderRole): RegisteredProvider {
    const provider = this.providers.get(this.key(kind, role));
    if (!provider) throw new ProviderError("PROVIDER_NOT_CONFIGURED", "Provider role is not registered", false);
    return provider;
  }
  catalog() { return [...this.providers.values()].map(({ kind, role, implementationStatus }) => ({ kind, role, implementationStatus })); }
}

// --- VE2E-00: capability preflight contract ---

export type PreflightOperationStatus = "ready" | "not_configured" | "capability_unavailable";
export type PreflightOperationResult = {
  role: ProviderRole;
  operation: string;
  status: PreflightOperationStatus;
  code?: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_CAPABILITY_UNAVAILABLE";
  detail?: string;
};
export type CapabilityPreflightResult = {
  ready: boolean;
  operations: PreflightOperationResult[];
};

/** A preflight is only "ready" when every required operation resolved to `ready`. */
export const summarizePreflight = (operations: PreflightOperationResult[]): CapabilityPreflightResult => ({
  ready: operations.length > 0 && operations.every((op) => op.status === "ready"),
  operations,
});
export {
  generateGemini,
  generateOpenAi,
  generateXai,
  generateContentOnce,
  generateContentStructuredV2,
  generateLiveStructured,
  generateVisionStructuredOnce,
  isLiveContentKind,
  liveContentKinds,
  verifyContentKey,
  type LiveContentInput,
  type LiveContentKind,
  type VisionInputPart,
} from "./live-content.js";
export { CONTENT_MODEL_RANKING_VERSION, CURATED_CONTENT_MODELS, mergeContentModels, discoveredContentModels, normalizeModelId, isTextContentModel, resolveContentModel, rankContentModels, suggestedModelFromError } from "./content-models.js";
export {
  probeContentModel,
  pickUsableContentModel,
  isFreshCheckedAt,
  findModelSnapshotEntry,
  CONTENT_MODEL_FRESHNESS_TTL_MS,
  type ContentModelProbeResult,
  type PickUsableContentModelResult,
  type ContentModelStatus,
  type ContentModelSnapshotEntry,
} from "./content-probe.js";
export {
  SCRIPT_DRAFT_V2_SCHEMA_VERSION,
  SCRIPT_DRAFT_V2_JSON_SCHEMA,
  SCRIPT_PROMPT_TEMPLATE_V2_VERSION,
  buildScriptV2PromptPackage,
  contentLanguagesV2,
  extractJsonObjectV2,
  isContentLanguageV2,
  isScriptSourceKind,
  parseScriptDraftV2,
  parseScriptDraftV2WithDiagnostics,
  validateScriptDraftV2,
  type VisualPlanParseDiagnostics,
  clipForPromptV2,
  scriptSourceKinds,
  type ContentLanguageV2,
  type ScriptDraftV2,
  type ScriptDraftSceneV2,
  type ScriptPromptPackageV2,
  type ScriptSourceKind,
} from "./script-draft-v2.js";
export {
  SCRIPT_VISUAL_PLAN_V2_JSON_SCHEMA,
  VISUAL_PLAN_MAX_SEGMENTS,
  VISUAL_PLAN_PRIORITY_MIN,
  VISUAL_PLAN_PRIORITY_MAX,
  normalizeScriptVisualPlanV2,
  diagnoseScriptVisualPlanV2,
  sanitizeVisualPlanJaKeywords,
  isValidJaSearchKeyword,
  isValidEnSearchKeyword,
  containsJapaneseChars,
  type VisualPlanRejectionReason,
  type VisualPlanDiagnosis,
  findVisualSegmentForScene,
  mediaSearchQueryForScene,
  type ScriptVisualPlanV2,
  type ScriptVisualSegmentV2,
  type ScriptVisualKeywordsV2,
  type ScriptVisualStyleHintsV2,
} from "./script-visual-plan.js";
export { generateScriptDraftV2, type GenerateScriptDraftV2Input, type GenerateScriptDraftV2Result, type ScriptGenerationDiagnostics } from "./live-script-v2.js";
export {
  SEGMENT_KEYWORDS_PROMPT_VERSION,
  SEGMENT_KEYWORDS_JSON_SCHEMA,
  buildSegmentKeywordsPrompt,
  parseSegmentKeywords,
  extractSegmentKeywords,
  type SegmentKeywordsInput,
  type ExtractedSegmentKeywords,
  type ExtractSegmentKeywordsResult,
} from "./segment-keywords.js";
export {
  SCRIPT_DRAFT_SCHEMA_VERSION,
  SCRIPT_DRAFT_V1_JSON_SCHEMA,
  SCRIPT_PROMPT_TEMPLATE_VERSION,
  buildScriptPromptPackage,
  contentLanguages,
  extractJsonObject,
  isContentLanguage,
  parseScriptDraftV1,
  validateScriptDraftV1,
  clipForPrompt,
  type ContentLanguage,
  type ScriptDraftV1,
  type ScriptDraftWorkflow,
  type ScriptPromptPackage,
} from "./script-draft-v1.js";
export { generateFakeScriptDraft } from "./fake-content.js";
export {
  CURATED_ELEVENLABS_MODELS,
  probeElevenLabsAccount,
  listElevenLabsVoices,
  getElevenLabsVoice,
  createElevenLabsVoiceClone,
  deleteElevenLabsVoice,
  textToSpeechWithTimestamps,
  probeElevenLabsTts,
  type ElevenLabsAccountInfo,
  type ElevenLabsVoiceSummary,
  type VoiceCloneConsentEvidence,
  type VoiceCloneSampleFile,
  type CreateVoiceCloneInput,
  type TtsAlignment,
  type TtsWithTimestampsResult,
  type TextToSpeechInput,
} from "./elevenlabs.js";
export {
  probePexelsAccount,
  searchPexelsPhotos,
  searchPexelsVideos,
  getPexelsPhoto,
  getPexelsVideo,
  pickPexelsVideoFile,
  isPexelsCdnUrl,
  pexelsPhotoToMediaCandidate,
  pexelsVideoToMediaCandidate,
  type PexelsAttribution,
  type PexelsPhotoResult,
  type PexelsVideoFileOption,
  type PexelsVideoResult,
  type PexelsSearchOptions,
  type PexelsCandidateContext,
} from "./pexels.js";
export {
  probeCreatomateAccount,
  listCreatomateTemplates,
  getCreatomateTemplate,
  deriveTemplateModifications,
  findTemplateTtsElements,
  ttsProviderOverrideKey,
  TTS_PROVIDER_DISABLED_VALUE,
  type TemplateTtsElement,
  submitCreatomateRender,
  resolveCreatomateRenderScale,
  readCreatomateCanvas,
  isRenderOutputBelowCanvas,
  submitCreatomateSourceRender,
  getCreatomateRender,
  normalizeCreatomateStatus,
  type CreatomateTemplateSummary,
  type CreatomateTemplateDetail,
  type ModificationKind,
  type TemplateModificationSlot,
  type CreatomateRenderStatus,
  type CreatomateRenderResult,
  type SubmitRenderInput,
  type SubmitSourceRenderInput,
} from "./creatomate.js";
export {
  extractDynamicStyleFromTemplate,
  buildDynamicComposition,
  buildDynamicCompositionWithWarnings,
  extractTemplateSceneLayout,
  countTemplateSceneSlots,
  templateResolution,
  applyDynamicStyleOverrides,
  isDynamicStyleOptionKey,
  isValidDynamicStyleOptionValue,
  DEFAULT_DYNAMIC_SCENE_STYLE,
  DYNAMIC_STYLE_OPTION_KEYS,
  type DynamicSceneInput,
  type DynamicSceneStyle,
  type DynamicImageAnimation,
  type TemplateSceneLayout,
  type TemplateScaleWarning,
  type DynamicCompositionResult,
} from "./creatomate-dynamic.js";
/** VE2E-52: structures of the two real pinned templates, shared by provider and API tests (not used at runtime). */
export { newsRecapJpTemplate, top5CountdownTemplate } from "./fixtures/creatomate-templates.js";
export {
  probeApifyAccount,
  searchApify,
  normalizeApifyItems,
  buildActorInput,
  hostMatchesSuffix,
  isApifyPlatform,
  apifyPlatforms,
  APIFY_ACTOR_ALLOWLIST,
  APIFY_HOST_ALLOWLIST,
  APIFY_MAX_RESULTS,
  APIFY_MAX_VIDEO_BYTES,
  APIFY_MAX_IMAGE_BYTES,
  APIFY_RUN_TIMEOUT_SECS,
  APIFY_DOWNLOAD_RUN_TIMEOUT_SECS,
  APIFY_TIKTOK_POST_URL_FIELD,
  fetchApifyTikTokPost,
  buildTikTokPostInput,
  emptyApifyUsage,
  addApifyUsage,
  type ApifyUsage,
  type ApifySearchRunOptions,
  type ApifyPostFetchInput,
  type ApifyPlatform,
  type ApifyLang,
  type ApifyActorPin,
  type ApifyDeps,
  type ApifyDownloadPlan,
  type ApifyCandidateResult,
  type ApifySearchOutcome,
  type ApifySearchInput,
} from "./apify.js";

export {
  probeYouTubeAccount,
  searchYouTubeVideos,
  isYouTubeUrl,
  youtubeVideoToMediaCandidate,
  type YouTubeVideoResult,
  type YouTubeSearchOptions,
  type YouTubeCandidateContext,
} from "./youtube.js";
export {
  probePinterestAccount,
  searchPinterestPins,
  pinterestPinToMediaCandidate,
  type PinterestMediaType,
  type PinterestPinResult,
  type PinterestSearchOptions,
  type PinterestCandidateContext,
} from "./pinterest.js";
export {
  probeVisionCapability,
  tryProbeVisionCapability,
  visionInputKinds,
  type VisionInputKind,
  type VisionCapabilityProbeResult,
} from "./vision-probe.js";
export {
  moderateMediaWithVision,
  moderateSceneCandidate,
  MAX_MODERATION_FRAMES,
  type VisionModerationOperation,
  type VisionModerationSceneContext,
  type VisionModerationFrame,
  type VisionModerationCallInput,
  type VisionModerationCallResult,
  type VisionModerationRawResult as VisionModerationProviderRawResult,
  type SceneModerationInput,
  type SceneModerationOutcome,
} from "./vision-moderation.js";
export {
  CAPTION_PLAN_SCHEMA_VERSION,
  CAPTION_PLAN_V1_JSON_SCHEMA,
  buildCaptionPlanPrompt,
  captionPlanFromScript,
  parseCaptionPlan,
  splitSpokenCaptions,
  type CaptionPlanV1,
  type CaptionSceneV1,
  type CaptionSegmentV1,
} from "./caption-plan-v1.js";
