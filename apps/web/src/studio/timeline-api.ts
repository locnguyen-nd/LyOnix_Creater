/**
 * VE2E-07: typed client for the real API-backed Studio timeline. Replaces
 * VE2E-07a's `creatomate-placeholder.ts` (static seam data) and `scaffold.ts`
 * (localStorage-only persistence) with calls to the actual VE2E-00..05 endpoints.
 */
import { API_ORIGIN, ApiError, api, csrfHeaders } from "../api";
import type {
  ApifyImportRequest,
  ApifySearchRequest,
  ApifySearchResponse,
  AudioVersionResponse,
  CreatomatePreviewConfigResponse,
  CreatomateTemplateSummaryResponse,
  ElevenLabsVoiceSummaryResponse,
  MediaAssetVersionSummary,
  MediaDeliveryIssueResponse,
  MediaPlanRequest,
  MediaPlanResponse,
  OrshotCostEstimateResponse,
  OrshotRenderOptions,
  PexelsMediaType,
  PexelsSearchResponse,
  RenderEngine,
  RenderJobResponse,
  SaveTimelineVersionRequest,
  StudioContextResponse,
  TemplateSnapshotResponse,
  TimelineDynamicPreviewResponse,
  TimelineRenderPreviewResponse,
  TimelineVersionResponse,
} from "@lyonix/contracts";

/** Short-lived signed browser-preview URL for one project media asset (image/video/audio) - same delivery mechanism Creatomate itself uses, just consumed by the Studio UI directly. */
export async function issueMediaDeliveryToken(mediaAssetVersionId: string): Promise<MediaDeliveryIssueResponse> {
  return api<MediaDeliveryIssueResponse>(`/media-assets/${mediaAssetVersionId}/delivery-tokens`, { method: "POST", headers: await csrfHeaders() });
}

export type AudioGenerationAccepted = { operationId: string; status: "queued" | "processing" | "completed" | "failed" | "unknown"; errorCode?: string; audioVersion?: AudioVersionResponse };

export async function fetchStudioContext(jobId: string): Promise<StudioContextResponse> {
  return api<StudioContextResponse>(`/jobs/${jobId}/studio/context`);
}

export async function saveTimelineVersion(projectId: string, input: SaveTimelineVersionRequest): Promise<TimelineVersionResponse> {
  return api<TimelineVersionResponse>(`/projects/${projectId}/timeline-versions`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(input),
  });
}

/** Uses the same server-side planner as Auto; the caller merges the returned media bindings into its editable Studio draft. */
export async function planProjectMedia(projectId: string, input: MediaPlanRequest): Promise<MediaPlanResponse> {
  return api<MediaPlanResponse>(`/projects/${projectId}/media-plans`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(input),
  });
}

export async function approveTimelineVersion(id: string): Promise<TimelineVersionResponse> {
  return api<TimelineVersionResponse>(`/timeline-versions/${id}/approve`, { method: "POST", headers: await csrfHeaders() });
}

export async function previewTimelineVersion(id: string): Promise<TimelineRenderPreviewResponse> {
  return api<TimelineRenderPreviewResponse>(`/timeline-versions/${id}/preview`);
}

export async function searchPexels(projectId: string, providerAccountId: string, type: PexelsMediaType, query: string, perPage?: number): Promise<PexelsSearchResponse> {
  const params = new URLSearchParams({ providerAccountId, type, query, ...(perPage ? { perPage: String(perPage) } : {}) });
  return api<PexelsSearchResponse>(`/projects/${projectId}/pexels/search?${params.toString()}`);
}

export async function importPexels(projectId: string, input: { providerAccountId: string; type: PexelsMediaType; externalId: string; sceneId?: string | null }): Promise<{ asset: MediaAssetVersionSummary }> {
  return api<{ asset: MediaAssetVersionSummary }>(`/projects/${projectId}/pexels/import`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(input),
  });
}

/** VE2E-34: runs a server-pinned Apify Actor for one platform (CSRF POST; the server picks the Actor, the client only names the platform). */
export async function searchApify(projectId: string, input: ApifySearchRequest): Promise<ApifySearchResponse> {
  return api<ApifySearchResponse>(`/projects/${projectId}/apify/search`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(input) });
}

/** VE2E-34: imports a candidate by its server-sealed `importRef` - the client never supplies a URL. */
export async function importApify(projectId: string, input: ApifyImportRequest): Promise<{ asset: MediaAssetVersionSummary }> {
  return api<{ asset: MediaAssetVersionSummary }>(`/projects/${projectId}/apify/import`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(input) });
}

export async function listProjectMedia(projectId: string): Promise<MediaAssetVersionSummary[]> {
  return api<MediaAssetVersionSummary[]>(`/projects/${projectId}/media-assets`);
}

export async function listElevenLabsVoices(providerAccountId: string): Promise<ElevenLabsVoiceSummaryResponse[]> {
  return api<ElevenLabsVoiceSummaryResponse[]>(`/provider-accounts/${providerAccountId}/elevenlabs/voices`);
}

/**
 * Voice Picker: a short TTS sample of a voice that has no provider preview (fixed sentence per language, chosen by the API).
 * Returns the audio; errors keep the API code (PROVIDER_QUOTA_EXHAUSTED, PROVIDER_RATE_LIMITED, ...) for the card to explain.
 */
export async function fetchVoicePreview(providerAccountId: string, voiceId: string, language: "vi" | "en" | "ja" | "ko", retried = false): Promise<Blob> {
  const response = await fetch(`${API_ORIGIN}/api/v1/provider-accounts/${encodeURIComponent(providerAccountId)}/elevenlabs/voices/${encodeURIComponent(voiceId)}/preview`, {
    method: "POST",
    credentials: "include",
    headers: { ...(await csrfHeaders()), "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ language }),
  });
  if (response.status === 401 && !retried) {
    const refreshed = await fetch(`${API_ORIGIN}/api/v1/auth/refresh`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
    if (refreshed.ok) return fetchVoicePreview(providerAccountId, voiceId, language, true);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(body?.error?.code ?? "PREVIEW_FAILED", body?.error?.message ?? "Không tạo được bản nghe thử");
  }
  return response.blob();
}

export async function generateSceneAudio(
  sceneDraftVersionId: string,
  input: { providerAccountId: string; voiceId: string; modelId?: string },
  idempotencyKey: string,
): Promise<AudioGenerationAccepted> {
  const headers = { ...(await csrfHeaders()), "idempotency-key": idempotencyKey };
  return api<AudioGenerationAccepted>(`/scene-versions/${sceneDraftVersionId}/audio-versions`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
}

export async function getAudioGenerationOperation(operationId: string): Promise<AudioGenerationAccepted> {
  return api<AudioGenerationAccepted>(`/audio-generation-operations/${operationId}`);
}

/** Latest-first; used to resolve a scene's already-generated audio (e.g. from an earlier session) for Studio preview playback without re-generating it. */
export async function listSceneAudioVersions(sceneDraftVersionId: string): Promise<AudioVersionResponse[]> {
  return api<AudioVersionResponse[]>(`/scene-versions/${sceneDraftVersionId}/audio-versions`);
}

export async function listCreatomateTemplates(providerAccountId: string): Promise<CreatomateTemplateSummaryResponse[]> {
  const params = new URLSearchParams({ providerAccountId });
  return api<CreatomateTemplateSummaryResponse[]>(`/creatomate/templates?${params.toString()}`);
}

export async function pinTemplateSnapshot(providerAccountId: string, externalTemplateId: string): Promise<TemplateSnapshotResponse> {
  return api<TemplateSnapshotResponse>(`/creatomate/template-snapshots`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ providerAccountId, externalTemplateId }),
  });
}

export async function getTemplateSnapshot(id: string): Promise<TemplateSnapshotResponse> {
  return api<TemplateSnapshotResponse>(`/creatomate/template-snapshots/${id}`);
}

export async function submitRenderFromTimeline(
  projectId: string,
  timelineVersionId: string,
  input: { providerAccountId: string; outputFormat?: "mp4" | "mov" | "gif"; idempotencyKey?: string; orshot?: OrshotRenderOptions; forceEngine?: RenderEngine },
): Promise<RenderJobResponse> {
  // The server deduplicates identical requests; a caller can supply a fresh key for an
  // intentional retry after a failed job.
  return api<RenderJobResponse>(`/projects/${projectId}/timeline-versions/${timelineVersionId}/render-jobs`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(input),
  });
}

/** Renders every scene the timeline has, not capped by the pinned template's own fixed slot count — see `RenderJobsService.submitDynamicFromTimeline`. */
export async function submitDynamicRenderFromTimeline(
  projectId: string,
  timelineVersionId: string,
  input: { providerAccountId: string; outputFormat?: "mp4" | "mov" | "gif"; idempotencyKey?: string; forceEngine?: RenderEngine },
): Promise<RenderJobResponse> {
  return api<RenderJobResponse>(`/projects/${projectId}/timeline-versions/${timelineVersionId}/dynamic-render-jobs`, {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(input),
  });
}

export async function getRenderJob(id: string): Promise<RenderJobResponse> {
  return api<RenderJobResponse>(`/render-jobs/${id}`);
}

/** VE2E-13: the exact dynamic render `source` JSON right now, for the Studio Preview SDK — no Creatomate call, no render job. */
export async function fetchTimelineDynamicPreviewSource(projectId: string, timelineVersionId: string): Promise<TimelineDynamicPreviewResponse> {
  return api<TimelineDynamicPreviewResponse>(`/projects/${projectId}/timeline-versions/${timelineVersionId}/dynamic-preview-source`);
}

/** VE2E-13: whether the Creatomate Preview SDK browser public token is configured server-side (B10/B11-gated). */
export async function fetchCreatomatePreviewConfig(): Promise<CreatomatePreviewConfigResponse> {
  return api<CreatomatePreviewConfigResponse>("/creatomate/preview-config");
}

/** Orshot only: narration seconds -> credits -> USD estimate for this timeline version. Read-only; never calls Orshot. */
export async function fetchOrshotEstimate(projectId: string, timelineVersionId: string): Promise<OrshotCostEstimateResponse> {
  return api<OrshotCostEstimateResponse>(`/projects/${projectId}/timeline-versions/${timelineVersionId}/orshot-estimate`);
}

/** Forces one live provider poll for a job (Orshot has no push progress; the webhook only triggers this same reconcile). */
export async function reconcileRenderJob(id: string): Promise<RenderJobResponse> {
  return api<RenderJobResponse>(`/render-jobs/${id}/reconcile`, { method: "POST", headers: await csrfHeaders() });
}
