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
  | "WEBHOOK_INVALID"
  // VE2E-15a: scene-beat media ranking abstained rather than importing a weak/unresolved-rights
  // candidate - both route the workflow run to `needs_input` (see `NEEDS_INPUT_CODES` in
  // apps/api/src/workflow-runner.service.ts), never an implicit accept.
  | "MEDIA_RELEVANCE_BELOW_THRESHOLD"
  | "MEDIA_RELEVANCE_UNVERIFIED"
  | "MEDIA_RIGHTS_UNRESOLVED"
  // VE2E-37: media-worker could not cut/deliver a derivative clip for render (timeout, broker down,
  // retryable worker error). Retryable; render never falls back to the full source file.
  | "MEDIA_PREPARE_FAILED"
  // VE2E-47: the pinned Creatomate template has an audio element with its own TTS `provider`
  // (Creatomate would synthesize + bill voice itself). CONFLICT = LyOnix refused to render;
  // FAILED = Creatomate-side TTS (ElevenLabs integration/quota) failed during the render.
  | "TEMPLATE_TTS_CONFLICT"
  | "TEMPLATE_TTS_FAILED";

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

/**
 * VE2E-38 (CR-JP-ONESHOT-MEDIA-2026-09-29 §4): whole-script background plan generated in the same
 * content-provider call as the script. Segments are runs of consecutive scenes covering the whole
 * script in order; `priority` 1..10 (1 = main subject); `keywords.ja` for Japanese-native media
 * sources, `keywords.en` for Pexels (at least one non-empty); `styleHints` keep one consistent look.
 */
export type ScriptVisualSegmentResponse = {
  segmentId: string;
  sceneIds: string[];
  subject: string;
  priority: number;
  keywords: { ja: string; en: string };
  styleHints: { setting: string; timeOfDay: string; lighting: string; palette: string };
};

export type ScriptVisualPlanResponse = { segments: ScriptVisualSegmentResponse[] };

export type ScriptDraftV2Response = {
  schemaVersion: "script-draft.v2";
  language: string;
  title: string;
  hook: string;
  body: string;
  cta: string;
  caption: string;
  scenes: ScriptDraftSceneV2Response[];
  /** VE2E-38 (optional, additive): `null`/absent = no usable plan; consumers fall back to per-scene `visualQuery`. */
  visualPlan?: ScriptVisualPlanResponse | null;
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
    providerRequestId?: string | null;
    usage?: { inputTokens: number | null; outputTokens: number | null; costAmount: string | null; costCurrency: string | null };
    rankingVersion?: string;
    selectionReason?: "preferred_account" | "automatic_preference";
  };
};

export const mediaAssetKinds = ["image", "video", "audio", "document"] as const;
export type MediaAssetKind = (typeof mediaAssetKinds)[number];

/** `apify` (VE2E-42, DEC-2026-09-29-JP-ONESHOT-MEDIA): social media fetched through an allowlisted Apify Actor - the adapter/registration path is VE2E-34; only the origin value exists here. */
export const mediaOrigins = ["upload", "import_url", "generated", "pexels", "apify"] as const;
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
  /** VE2E-42 lineage: the source asset this one was derived from (e.g. a clip trimmed by media-worker), null for an original. */
  parentMediaAssetVersionId: string | null;
  /** VE2E-42 lineage: how this derivative was produced from its parent; null for an original (or an unreadable stored value). */
  transform: MediaAssetTransform | null;
};

/**
 * VE2E-42: how a derivative `MediaAssetVersion` was produced from its `parentMediaAssetVersionId`
 * (CR-JP-ONESHOT-MEDIA-2026-09-29 §8), stored as `MediaAssetVersion.transform` JSON and written by the
 * media-worker derivative flow (VE2E-36/37). `range` is expressed in the parent's own timeline (ms);
 * `stripAudio` records that the audio track was removed at file level (mandatory for social sources,
 * DEC-2026-09-29 #1); `tool`/`profileVersion` pin what produced the file, for audit/reproducibility.
 */
export type MediaAssetTransform = {
  range: { startMs: number; durationMs: number } | null;
  stripAudio: boolean;
  tool: { name: string; version: string } | null;
  profileVersion: string | null;
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

// --- VE2E-34: Apify social/web media search + import (DEC-2026-09-29-JP-ONESHOT-MEDIA #1/#5/#10-#16) ---

export const apifyPlatformIds = ["tiktok", "pinterest", "x", "google_image", "google_video"] as const;
export type ApifyPlatformId = (typeof apifyPlatformIds)[number];

/** `POST /projects/:projectId/apify/search` (CSRF; runs a paid, allowlisted Actor - the Actor is chosen by the server from `platform`, never by the client). */
export type ApifySearchRequest = {
  /** Verified `visual` Apify provider account. */
  providerAccountId: string;
  platform: ApifyPlatformId;
  query: string;
  /** Keyword language (Japanese-market first). Defaults to `ja`. */
  lang?: "ja" | "en";
  /** 1..20 (server cap). */
  limit?: number;
};

export type ApifyCandidateResponse = {
  candidateId: string;
  platform: ApifyPlatformId;
  mediaType: "video" | "photo";
  /** False = preview/discovery only (Google video, Pinterest HLS-only, TikTok without an Apify-stored file). */
  importable: boolean;
  /** Machine-readable reason when not importable. */
  previewOnlyReason: string | null;
  /** Only a host-allowlisted (CDN/gstatic) preview URL, or "" - never a download URL and never a URL carrying a token. */
  previewUrl: string;
  durationSeconds: number | null;
  widthPx: number | null;
  heightPx: number | null;
  title: string;
  author: string | null;
  sourcePageUrl: string | null;
  /** Always `owner_accepted_risk` (DEC #1): the owner accepted the social-media rights risk; NOT `cleared`. */
  rightsStatus: "owner_accepted_risk";
  /** Opaque server-sealed reference (encrypted + authenticated, expires) used by the import endpoint; `null` when not importable. */
  importRef: string | null;
};

export type ApifySearchResponse = {
  platform: ApifyPlatformId;
  query: string;
  lang: "ja" | "en";
  actor: { actorId: string; version: string; role: "primary" | "backup" };
  fetchedAt: string;
  /** Set when the primary Actor failed and the pinned backup produced these results. */
  primaryError: { code: string; message: string } | null;
  candidates: ApifyCandidateResponse[];
};

/** `POST /projects/:projectId/apify/import` (CSRF). Only a sealed `importRef` from a search - never a client-supplied URL. */
export type ApifyImportRequest = {
  providerAccountId: string;
  importRef: string;
  folderId?: string | null;
  reusable?: boolean;
  sceneId?: string | null;
};

export type ApifyImportResponse = {
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
  /** VE2E-47: set on an audio `.source` slot whose template element carries a Creatomate-side TTS `provider` (e.g. "elevenlabs model_id=... voice_id=..."). */
  ttsProvider?: string;
};

export type TemplateSnapshotWarning = {
  code: "TEMPLATE_TTS_PROVIDER";
  elementName: string;
  /** The `<name>.source` slot key when the element is dynamic (LyOnix fills it); null for a fixed element. */
  slotKey: string | null;
  provider: string;
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
  /** VE2E-47: non-blocking template problems (currently: audio elements with a Creatomate TTS provider). Omitted/empty when clean. */
  warnings?: TemplateSnapshotWarning[];
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
  /** VE2E-47: explicit opt-in to let Creatomate run its own (billed) TTS for template audio slots LyOnix leaves without voice. Default false = fail closed. */
  allowTemplateTts?: boolean;
};

export const renderJobStatuses = [
  "accepted",
  "preparing_clips",
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
  clipPreparation: { clipsTotal: number; clipsReady: number; failed: Array<{ sceneId: string; code: string; message: string }> };
  resultUrl: string | null;
  /** VE2E-19: Creatomate's own render-frame preview image, when the provider includes one. */
  snapshotUrl: string | null;
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

/** VE2E-19: per-channel finished-video library entry (GET /channels/:id/videos). */
export type ChannelVideoResponse = {
  jobId: string;
  renderJobId: string;
  title: string;
  caption: string;
  createdByName: string | null;
  thumbnailUrl: string | null;
  resultUrl: string;
  renderDurationMs: number | null;
  completedAt: string;
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
  /** VE2E-38: the persisted `visualPlan` (`null` for versions without one, including every version stored before VE2E-38). */
  visualPlan: ScriptVisualPlanResponse | null;
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
  /** VE2E-40: background segment count for this run; omitted = `{ mode: "auto" }`. Persisted on the run (retry/resume reuse it). */
  backgroundSegments?: BackgroundSegmentsSetting;
};

/**
 * VE2E-40 (DEC-2026-09-29-JP-ONESHOT-MEDIA #2): number of background ("one-shot") segments.
 * `auto` = by video length (<= 30s: 2-3, > 30s: 3-5; by the intake target duration, else the real
 * total voice duration); `fixed` = exactly `count`, validated server-side against configurable
 * bounds (placeholder 1..6). Rules live in `@lyonix/domain/background-segments`.
 */
export type BackgroundSegmentsSetting = { mode: "auto" } | { mode: "fixed"; count: number };

/** VE2E-40: the persisted setting plus the segment-count range it resolves to for this run (`null` = auto with no known duration yet). */
export type BackgroundSegmentsResolvedResponse = {
  setting: BackgroundSegmentsSetting;
  range: { min: number; max: number } | null;
};

/**
 * VE2E-31: `POST /projects/:projectId/media-plans` - runs the same server-side MediaPlanService the
 * Auto runner uses (segments + one source B-roll per segment + contiguous per-scene source ranges)
 * for one script version and returns timeline bindings WITHOUT saving a TimelineVersion (Studio,
 * VE2E-41, saves through the normal timeline save). It does search/import media into the project
 * library (Pexels calls + asset rows), so it is a CSRF-protected POST.
 */
export type MediaPlanRequest = {
  scriptDraftVersionId: string;
  /** Verified `visual` (Pexels) provider account. */
  providerAccountId: string;
  /** Omitted = `{ mode: "auto" }`, resolved against the scenes' real voice duration. */
  backgroundSegments?: BackgroundSegmentsSetting;
};

export type MediaPlanSegmentDiagnostics = {
  segmentId: string;
  origin: "visual_plan" | "fallback";
  /** `reused` = an asset already assigned to the segment's first scene in this project; `imported` = newly searched + imported; `failed` = no acceptable source (see `errorCode`), scenes left unbound. */
  sourcing: "reused" | "imported" | "failed";
  errorCode: string | null;
  durationMs: number;
  /** Source shorter than the segment: some scene restarted from 0 at a scene boundary (documented loop policy). */
  looped: boolean;
  /** A single scene longer than the whole source clip (its range is the whole clip, shorter than the voice). */
  short: boolean;
  /** VE2E-46: where the segment's source came from (`null`/absent when sourcing failed). */
  sourceProvider?: "apify" | "pexels" | null;
  /** VE2E-46: why Apify was skipped/not used before falling back to Pexels (e.g. `apify_no_usable_candidate`, `apify_error:PROVIDER_TIMEOUT`, `no_ja_keywords`); `null` when Apify was not involved or succeeded. */
  fallbackReason?: string | null;
  /** VE2E-46: audit trail of an Apify-sourced segment (also stored on the imported asset). */
  apifyProvenance?: { platform: string; actorId: string; actorVersion: string; sourceUrl: string | null; author: string | null; fetchedAt: string } | null;
};

export type MediaPlanResponse = {
  policyVersion: string;
  range: { min: number; max: number } | null;
  /** Ready to send as `SaveTimelineVersionRequest.scenes`/`segments` (Studio merges its own audio/text bindings). */
  scenes: Array<{ sceneId: string; mediaAssetVersionId: string | null; segmentId: string | null; sourceStartMs: number | null; sourceDurationMs: number | null }>;
  segments: TimelineSegmentInput[];
  diagnostics: MediaPlanSegmentDiagnostics[];
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
  /** VE2E-40: the run's persisted background segment setting (legacy runs read as auto) and its resolved range. */
  backgroundSegments: BackgroundSegmentsResolvedResponse;
  createdAt: string;
  updatedAt: string;
};

/**
 * VE2E-22: `GET /video-productions` — every Auto submit provisions its own brand-new
 * `Project` (see `VideoProductionsService.setupAutoProfile`), so a run is never one of
 * several sharing a project; without this list, a run submitted from `JobNewPage` and
 * then navigated away from (its id only ever appears once, in that submit response /
 * URL) had no way to be found again anywhere in the UI or API.
 */
export type VideoProductionListItemResponse = {
  id: string;
  projectId: string;
  status: WorkflowRunStatus;
  sourceVersionId: string | null;
  title: string | null;
  caption: string | null;
  sourceType: SourceType | null;
  createdByName: string | null;
  resultUrl: string | null;
  /** VE2E-22: Creatomate's own render-frame preview image (`RenderJob.snapshotUrl`, VE2E-19), when the provider has reported one - so the list can show a thumbnail without playing/re-hosting the video itself. */
  snapshotUrl: string | null;
  costAmount: string | null;
  costCurrency: string | null;
  renderDurationMs: number | null;
  lastError: { code: string; message: string; stepKey?: string } | null;
  createdAt: string;
  updatedAt: string;
};

// --- VE2E-07: Professional Studio API-backed TimelineVersion ---

export const timelineVersionStatuses = ["draft", "approved"] as const;
export type TimelineVersionStatus = (typeof timelineVersionStatuses)[number];

/**
 * One scene's bindings in a Studio timeline. `mediaAssetVersionId`/`audioVersionId`/
 * `subtitleVersionId` are opaque cross-references (no Prisma FK - same posture as
 * `MediaAssetVersion.sceneId`), validated against the timeline's own `projectId` in
 * `timeline-versions.service.ts`, not by the database. `screenTextOverride` lets Studio
 * show different on-screen text than the pinned script's `screenText` without creating a
 * new `ScriptDraftVersion` (a real script edit still goes through `script-versions.service.ts`).
 */
export type TimelineSceneBindingInput = {
  sceneId: string;
  mediaAssetVersionId?: string | null;
  audioVersionId?: string | null;
  subtitleVersionId?: string | null;
  screenTextOverride?: string | null;
  annotation?: string | null;
  /** User-toggled "remove from render" — the scene and its authored content are kept, just skipped when building the render (dynamic composition drops it, same as a scene with no audio yet). */
  excluded?: boolean;
  /**
   * VE2E-42 (optional, additive): the background segment this scene belongs to; must name a
   * `segments[]` entry of the same timeline that lists this scene. Absent/null = not part of a
   * planned segment (every timeline saved before VE2E-42).
   */
  segmentId?: string | null;
  /**
   * VE2E-42 (optional, additive): the slice of the bound source video this scene uses, in the
   * source's own timeline (ms). Set both or neither; only allowed on a scene bound to a `video`
   * asset. Absent = the source is used from its start, exactly as before VE2E-42. The derivative
   * for this range is cut at render time by media-worker (VE2E-37), never in the API.
   */
  sourceStartMs?: number | null;
  sourceDurationMs?: number | null;
};

export type TimelineSceneBindingResponse = {
  sceneId: string;
  orderIndex: number;
  mediaAssetVersionId: string | null;
  audioVersionId: string | null;
  subtitleVersionId: string | null;
  screenTextOverride: string | null;
  annotation: string | null;
  excluded: boolean;
  /** VE2E-42: see `TimelineSceneBindingInput.segmentId`; `null` on timelines saved before VE2E-42. */
  segmentId: string | null;
  /** VE2E-42: see `TimelineSceneBindingInput.sourceStartMs`; `null` = no range (source used as before). */
  sourceStartMs: number | null;
  sourceDurationMs: number | null;
};

/**
 * VE2E-42: one background segment - a run of consecutive scenes (timeline order) sharing one
 * B-roll source (CR-JP-ONESHOT-MEDIA-2026-09-29 §4/§8). `priority` is an integer 1..10 where
 * 1 = the video's main subject; `subject` is a short label. Structural rules live in
 * `@lyonix/domain/timeline-segments` (`validateTimelineSegmentStructure`).
 */
export type TimelineSegmentInput = {
  segmentId: string;
  sceneIds: string[];
  mediaAssetVersionId?: string | null;
  subject?: string | null;
  priority?: number | null;
};

export type TimelineSegmentResponse = {
  segmentId: string;
  sceneIds: string[];
  mediaAssetVersionId: string | null;
  subject: string | null;
  priority: number | null;
};

/** Template-level modification values not tied to one scene (secondary text/color/font/volume), keyed by the pinned `TemplateSnapshot`'s modification key. */
export type TimelineOptionValues = Record<string, string>;

export type SaveTimelineVersionRequest = {
  /** id of the version this save supersedes, or `null` for a project's first timeline version. The server rejects with `VERSION_CONFLICT` if this does not match the project's actual latest version (optimistic concurrency, same pattern as `ScriptDraftVersion.supersedesId`). */
  supersedesId: string | null;
  templateSnapshotId?: string | null;
  scenes: TimelineSceneBindingInput[];
  optionValues?: TimelineOptionValues;
  /** VE2E-42 (optional): background segments; omitted/empty = no segment plan (pre-VE2E-42 behavior). */
  segments?: TimelineSegmentInput[];
};

export type TimelineVersionResponse = {
  id: string;
  projectId: string;
  version: number;
  status: TimelineVersionStatus;
  templateSnapshotId: string | null;
  scenes: TimelineSceneBindingResponse[];
  optionValues: TimelineOptionValues;
  /** VE2E-42: always an array; empty for timelines saved before VE2E-42 or without a segment plan. */
  segments: TimelineSegmentResponse[];
  supersedesId: string | null;
  /** VE2E-42: set when this version was written + auto-approved by an Auto `WorkflowRun` (exactly what that run rendered); null for Studio-authored versions. */
  workflowRunId: string | null;
  createdAt: string;
  approvedAt: string | null;
};

/**
 * Dry-run preview (spec §5 "Render: build dry-run payload"; §7 "preview badge khi chưa
 * phải Creatomate render thật") - reports which modification keys the current timeline
 * would fill and which required ones are still missing, without resolving signed media
 * URLs or calling Creatomate.
 */
export type TimelineRenderPreviewResponse = {
  ready: boolean;
  filledModificationKeys: string[];
  missingRequiredModificationKeys: string[];
};

export type RenderSubmitFromTimelineRequest = {
  providerAccountId: string;
  outputFormat?: "mp4" | "mov" | "gif";
  idempotencyKey?: string;
  /** VE2E-47: see `RenderSubmitRequest.allowTemplateTts`. */
  allowTemplateTts?: boolean;
};

/**
 * VE2E-13: the exact fully-dynamic Creatomate `source` JSON a `POST
 * .../dynamic-render-jobs` submit would send right now, without calling Creatomate or
 * creating a `RenderJob` — what the Studio Preview SDK loads via `setSource()`. `ready:
 * false` (with `missingReason`) is an expected, non-error editing state (e.g. no scene has
 * both audio and media yet), not a failure.
 */
export type TimelineDynamicPreviewResponse = {
  ready: boolean;
  source: Record<string, unknown> | null;
  renderableSceneCount: number;
  totalSceneCount: number;
  missingReason: string | null;
};

/** VE2E-13: whether the Creatomate Preview SDK's browser-side public token is configured server-side (B10/B11-gated) - never the render API secret. */
export type CreatomatePreviewConfigResponse = {
  configured: boolean;
  publicToken: string | null;
};

// --- VE2E-07: legacy-job -> Project/SourceVersion/ScriptDraftVersion Studio bridge ---

export type StudioSceneContextResponse = {
  /** The persisted `SceneDraftVersion.id` - required by `POST /scene-versions/:id/audio-versions` (VE2E-03), distinct from the opaque `sceneId` string used for media assignment (VE2E-04). */
  id: string;
  sceneId: string;
  orderIndex: number;
  narration: string;
  screenText: string;
  visualQuery: string;
  durationHintMs: number;
};

/**
 * Bootstraps Studio for a legacy job: idempotently provisions (first call) or looks up
 * (later calls) the `Project`/`SourceVersion`/`ScriptDraftVersion` bridged 1:1 to this
 * `ProductionRequest`, so Studio can attach real media/audio/template/timeline state
 * instead of the client-only localStorage scaffold from VE2E-07a.
 */
export type StudioContextResponse = {
  jobId: string;
  projectId: string;
  sourceVersionId: string;
  scriptDraftVersionId: string;
  scenes: StudioSceneContextResponse[];
  latestTimelineVersion: TimelineVersionResponse | null;
  /** VE2E-38: the bridged script version's `visualPlan` (segments + ja/en keywords to prefill Studio search), `null` when none. */
  visualPlan: ScriptVisualPlanResponse | null;
};
