export const API_PREFIX = "/api/v1" as const;

export const roles = ["admin", "staff"] as const;
export type Role = (typeof roles)[number];

export const locales = ["vi", "en", "ja", "ko"] as const;
export type UiLocale = (typeof locales)[number];

export const operationStatuses = [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "needs_attention",
] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export type RequestMeta = { requestId: string };
export type Success<T> = { data: T; meta: RequestMeta };
export type Page = { nextCursor: string | null; hasMore: boolean };
export type ListSuccess<T> = { data: T[]; page: Page; meta: RequestMeta };
export type ErrorDetail = { field?: string; code: string };

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "ACCOUNT_PENDING_APPROVAL"
  | "ACCOUNT_EMAIL_TAKEN"
  | "AUTH_RATE_LIMITED"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATE"
  | "DUPLICATE_TOPIC_REQUIRES_OVERRIDE"
  | "PROVIDER_AUTH_INVALID"
  | "PROVIDER_CAPABILITY_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "PROVIDER_SCHEMA_INVALID"
  | "PROVIDER_CONTENT_REFUSED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_SUBMIT_UNKNOWN"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_NOT_CONFIGURED"
  | "UPLOAD_LIMIT_EXCEEDED"
  | "UNSUPPORTED_MEDIA"
  | "SSRF_BLOCKED"
  | "REVENUE_UNAVAILABLE"
  | "WEBHOOK_INVALID";

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    retryable: boolean;
  };
  meta: RequestMeta;
};

export type AsyncOperation = {
  operationId: string;
  resourceType: string;
  resourceId: string;
  status: OperationStatus;
  pollUrl: `${typeof API_PREFIX}/operations/${string}`;
};

// --- VE2E-00: project/source/media/workflow foundation contract ---

export type ProjectSummary = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export const sourceTypes = ["topic", "raw_script", "article_url", "file"] as const;
export type SourceType = (typeof sourceTypes)[number];

export const sourceFetchStatuses = ["pending", "fetched", "extracted", "failed", "blocked"] as const;
export type SourceFetchStatus = (typeof sourceFetchStatuses)[number];

export type SourceVersionSummary = {
  id: string;
  projectId: string;
  type: SourceType;
  version: number;
  originRef: string | null;
  fetchStatus: SourceFetchStatus;
  fetchError: string | null;
  checksumSha256: string | null;
  createdAt: string;
  approvedAt: string | null;
};

// --- VE2E-01: SourceVersion -> ScriptDraftV2 ---

export type ScriptDraftSceneV2Response = {
  sceneId: string;
  narration: string;
  screenText: string;
  visualQuery: string;
  durationHintMs: number;
};

export type ScriptDraftV2Response = {
  schemaVersion: "script-draft.v2";
  language: string;
  title: string;
  hook: string;
  body: string;
  cta: string;
  caption: string;
  scenes: ScriptDraftSceneV2Response[];
};

export type ScriptDraftV2GenerationResponse = {
  sourceId: string;
  draft: ScriptDraftV2Response;
  providerPin: {
    accountId: string;
    provider: string;
    modelId: string;
    configVersion: number;
    promptTemplateVersion: string;
  };
};

export const mediaAssetKinds = ["image", "video", "audio", "document"] as const;
export type MediaAssetKind = (typeof mediaAssetKinds)[number];

export const mediaOrigins = ["upload", "import_url", "generated", "pexels"] as const;
export type MediaOrigin = (typeof mediaOrigins)[number];

export const retentionClasses = ["project", "working"] as const;
export type RetentionClass = (typeof retentionClasses)[number];

export type MediaFolderSummary = {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
};

/** Pexels license requires crediting the photographer and linking back to Pexels — always present when `origin==="pexels"`. */
export type PexelsAttribution = {
  photographerName: string;
  photographerUrl: string;
  pexelsPageUrl: string;
};

export type MediaAssetVersionSummary = {
  id: string;
  projectId: string;
  folderId: string | null;
  kind: MediaAssetKind;
  originalFileName: string;
  mimeType: string;
  checksumSha256: string;
  bytes: number;
  widthPx: number | null;
  heightPx: number | null;
  durationMs: number | null;
  origin: MediaOrigin;
  license: string | null;
  reusable: boolean;
  retentionClass: RetentionClass;
  expiresAt: string | null;
  version: number;
  createdAt: string;
  /** Opaque client-supplied scene identifier this asset is currently assigned to (VE2E-04), null when unassigned. */
  sceneId: string | null;
  /** Attribution to display in the UI next to this asset; only set for `origin==="pexels"`. */
  attribution: PexelsAttribution | null;
};

// --- VE2E-04: Pexels search/import + media library extras ---

export const pexelsMediaTypes = ["photo", "video"] as const;
export type PexelsMediaType = (typeof pexelsMediaTypes)[number];

export type PexelsVideoFileOptionResponse = {
  quality: string;
  width: number;
  height: number;
  fileType: string;
};

export type PexelsPhotoSearchResultResponse = {
  externalId: string;
  width: number;
  height: number;
  attribution: PexelsAttribution;
  thumbnailUrl: string;
  previewUrl: string;
};

export type PexelsVideoSearchResultResponse = {
  externalId: string;
  width: number;
  height: number;
  durationSeconds: number;
  attribution: PexelsAttribution;
  thumbnailUrl: string;
  fileOptions: PexelsVideoFileOptionResponse[];
};

export type PexelsSearchResponse = {
  type: PexelsMediaType;
  query: string;
  page: number;
  perPage: number;
  photos: PexelsPhotoSearchResultResponse[];
  videos: PexelsVideoSearchResultResponse[];
};

export type PexelsImportResponse = {
  asset: MediaAssetVersionSummary;
};

// --- VE2E-02: ElevenLabs voices, consented clone and TTS-with-timestamps ---

export type ElevenLabsVoiceSummaryResponse = {
  voiceId: string;
  name: string;
  category: string | null;
  /** Provider's own short-lived CDN preview link. Never raw audio bytes/logged by LyOnix. */
  previewUrl: string | null;
};

export type VoiceCloneConsentRequest = {
  statementVersion: string;
  statementText: string;
  acceptedAt: string;
};

export type VoiceCloneSampleFileInput = {
  fileName: string;
  mimeType: string;
  base64Data: string;
};

export type VoiceCloneResultResponse = {
  providerAccountId: string;
  voiceId: string;
  name: string;
  consentRecordId: string;
};

export type TtsAlignmentResponse = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

export type TtsGenerationResponse = {
  asset: MediaAssetVersionSummary;
  alignment: TtsAlignmentResponse;
  durationMs: number;
  providerPin: { accountId: string; provider: string; voiceId: string; modelId: string };
};

export const workflowRunModes = ["auto", "studio"] as const;
export type WorkflowRunMode = (typeof workflowRunModes)[number];

export const workflowRunStatuses = [
  "draft",
  "source_ready",
  "scripting",
  "awaiting_script_approval",
  "voice_generating",
  "aligning",
  "media_preparing",
  "editing",
  "ready_to_render",
  "render_queued",
  "rendering",
  "verifying",
  "completed",
  "blocked_provider",
  "needs_input",
  "failed",
  "cancelled",
  "reconciling",
] as const;
export type WorkflowRunStatus = (typeof workflowRunStatuses)[number];

export const preflightOperationStatuses = ["ready", "not_configured", "capability_unavailable"] as const;
export type PreflightOperationStatus = (typeof preflightOperationStatuses)[number];

export type PreflightOperation = {
  role: string;
  operation: string;
  status: PreflightOperationStatus;
  code?: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_CAPABILITY_UNAVAILABLE";
  detail?: string;
};

export type CapabilityPreflightResponse = {
  profileId: string;
  ready: boolean;
  operations: PreflightOperation[];
};

export type MediaDeliveryIssueResponse = {
  token: string;
  url: string;
  expiresAt: string;
};

// --- VE2E-05: Creatomate template snapshot + render lifecycle ---

export const modificationKinds = ["text", "video", "image", "audio", "color", "font", "volume"] as const;
export type ModificationKind = (typeof modificationKinds)[number];

export type TemplateModificationSlotResponse = {
  key: string;
  kind: ModificationKind;
  label: string;
  required: boolean;
};

export type CreatomateTemplateSummaryResponse = {
  externalTemplateId: string;
  name: string;
  previewUrl: string | null;
  tags: string[];
};

export type TemplateSnapshotResponse = {
  id: string;
  externalTemplateId: string;
  name: string;
  previewUrl: string | null;
  modifications: TemplateModificationSlotResponse[];
  capturedAt: string;
};

/**
 * Structured, server-owned render input: the client selects a whitelisted
 * `modificationKey` (must exist on the pinned `TemplateSnapshot`) and provides only
 * a typed value per `kind` — never an arbitrary Creatomate modification object. The
 * server resolves `media` assignments into a short-lived signed media-delivery URL
 * before building the real Creatomate payload.
 */
export type RenderAssignmentInput =
  | { modificationKey: string; kind: "text"; text: string }
  | { modificationKey: string; kind: "video" | "image" | "audio"; mediaAssetVersionId: string }
  | { modificationKey: string; kind: "color"; color: string }
  | { modificationKey: string; kind: "font"; fontFamily: string }
  | { modificationKey: string; kind: "volume"; volumePercent: number };

export type RenderSubmitRequest = {
  templateSnapshotId: string;
  providerAccountId: string;
  assignments: RenderAssignmentInput[];
  outputFormat?: "mp4" | "mov" | "gif";
  /** Optional client-supplied idempotency token (e.g. one generated per "Render" button click) folded into the server-computed request fingerprint. */
  idempotencyKey?: string;
};

export const renderJobStatuses = [
  "accepted",
  "queued",
  "rendering",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "reconciling",
  "blocked_provider",
] as const;
export type RenderJobStatus = (typeof renderJobStatuses)[number];

export type RenderJobResponse = {
  id: string;
  projectId: string;
  templateSnapshotId: string;
  status: RenderJobStatus;
  externalJobId: string | null;
  progress: number | null;
  resultUrl: string | null;
  resultExpiresAt: string | null;
  attempts: number;
  requestFingerprint: string;
  costAmount: string | null;
  costCurrency: string | null;
  renderDurationMs: number | null;
  lastError: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};

// --- VE2E-03: persisted ScriptDraftVersion/SceneDraftVersion + AudioVersion/SubtitleVersion ---

export const scriptDraftVersionStatuses = ["draft", "approved"] as const;
export type ScriptDraftVersionStatus = (typeof scriptDraftVersionStatuses)[number];

export type SceneDraftVersionResponse = {
  id: string;
  sceneId: string;
  orderIndex: number;
  narration: string;
  screenText: string;
  visualQuery: string;
  durationHintMs: number;
};

export type ScriptDraftVersionResponse = {
  id: string;
  sourceVersionId: string;
  version: number;
  status: ScriptDraftVersionStatus;
  language: string;
  title: string;
  hook: string;
  body: string;
  cta: string;
  caption: string;
  providerPin: {
    accountId: string;
    provider: string;
    modelId: string;
    configVersion: number;
    promptTemplateVersion: string;
  };
  supersedesId: string | null;
  createdAt: string;
  approvedAt: string | null;
  scenes: SceneDraftVersionResponse[];
};

export const audioSubtitleVersionStatuses = ["current", "stale"] as const;
export type AudioSubtitleVersionStatus = (typeof audioSubtitleVersionStatuses)[number];

export type CaptionSegmentResponse = {
  text: string;
  startMs: number;
  endMs: number;
};

export type SubtitleVersionResponse = {
  id: string;
  audioVersionId: string;
  version: number;
  status: AudioSubtitleVersionStatus;
  source: string;
  segments: CaptionSegmentResponse[];
  staleReason: string | null;
  createdAt: string;
};

export type AudioVersionResponse = {
  id: string;
  sceneDraftVersionId: string;
  version: number;
  status: AudioSubtitleVersionStatus;
  providerAccountId: string;
  provider: string;
  externalVoiceId: string;
  modelId: string;
  mediaAssetVersionId: string;
  durationMs: number;
  alignment: TtsAlignmentResponse;
  staleReason: string | null;
  createdAt: string;
  subtitleVersion: SubtitleVersionResponse | null;
};

// --- VE2E-06: one-click AutomationProfile orchestrator (POST /video-productions) ---

/**
 * `mode:"auto"` is the only mode this endpoint executes end-to-end today (zero human
 * gate, per DEC-2026-09-24 §9). `mode:"studio"` is accepted by the request shape (the
 * domain already models both modes via `WorkflowRunMode`) but rejected with
 * `VALIDATION_FAILED` at submit time — Studio's own pause/edit/approve submit contract
 * is VE2E-07/08 scope, not redefined here.
 */
export type VideoProductionSourceInput =
  | { type: "topic"; topic: string }
  | { type: "raw_script"; rawScript: string }
  | { type: "article_url"; url: string };

export type VideoProductionSubmitRequest = {
  mode: WorkflowRunMode;
  projectId: string;
  automationProfileId: string;
  /** Reuse an already-created `SourceVersion` (e.g. from `POST /projects/:id/sources`). Mutually exclusive with `source`. */
  sourceId?: string;
  /** Inline-create a new `SourceVersion` for this run. Mutually exclusive with `sourceId`. `file` sources are not supported inline (no text extraction adapter exists yet — see VE2E-01 handoff); create the source via the existing endpoint and pass `sourceId` instead. */
  source?: VideoProductionSourceInput;
};

export type VideoProductionSubmitResponse = {
  id: string;
  status: WorkflowRunStatus;
  pollUrl: string;
  eventsUrl: string;
};

export type WorkflowStepEventResponse = {
  stepKey: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  attempt: number;
  error: { code: string; message: string } | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type VideoProductionResponse = {
  id: string;
  projectId: string;
  mode: WorkflowRunMode;
  status: WorkflowRunStatus;
  attempts: number;
  sourceVersionId: string | null;
  scriptDraftVersionId: string | null;
  renderJobId: string | null;
  resultUrl: string | null;
  lastError: { code: string; message: string; stepKey?: string } | null;
  createdAt: string;
  updatedAt: string;
};
