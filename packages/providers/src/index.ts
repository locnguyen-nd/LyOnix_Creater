export const providerKinds = ["fake", "openai", "gemini", "xai", "vrew", "capcut"] as const;
export type ProviderKind = (typeof providerKinds)[number];
export const providerRoles = ["content", "tts", "visual", "render"] as const;
export type ProviderRole = (typeof providerRoles)[number];
export type ProviderErrorCode = "PROVIDER_AUTH_INVALID" | "PROVIDER_CAPABILITY_UNAVAILABLE" | "PROVIDER_RATE_LIMITED" | "PROVIDER_QUOTA_EXHAUSTED" | "PROVIDER_SCHEMA_INVALID" | "PROVIDER_CONTENT_REFUSED" | "PROVIDER_TIMEOUT" | "PROVIDER_SUBMIT_UNKNOWN" | "PROVIDER_UNAVAILABLE";

export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly retryable: boolean, readonly retryAfterMs?: number) { super(message); }
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
export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private key(kind: ProviderKind, role: ProviderRole) { return `${kind}:${role}`; }
  register(provider: RegisteredProvider) { const key = this.key(provider.kind, provider.role); if (this.providers.has(key)) throw new Error(`Provider already registered: ${key}`); this.providers.set(key, provider); }
  resolve(kind: ProviderKind, role: ProviderRole): RegisteredProvider { const provider = this.providers.get(this.key(kind, role)); if (!provider) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", "Provider role is not registered", false); return provider; }
  catalog() { return [...this.providers.values()].map(({ kind, role, implementationStatus }) => ({ kind, role, implementationStatus })); }
}
export { generateGemini, generateOpenAi, generateXai, generateLiveStructured, isLiveContentKind, liveContentKinds, verifyContentKey, type LiveContentInput, type LiveContentKind } from "./live-content.js";
export { CURATED_CONTENT_MODELS, mergeContentModels, normalizeModelId, isTextContentModel, resolveContentModel, suggestedModelFromError } from "./content-models.js";
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
