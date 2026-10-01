/**
 * VE2E-08: typed client for the Auto "one-click" entry (spec §7 "Auto entry") — provisions
 * the Project/AutomationProfileVersion a submit needs, then drives the VE2E-06
 * `POST /video-productions` DAG and polls its live status/events.
 */
import { api, csrfHeaders } from "./api";
import type {
  BackgroundSegmentsSetting,
  QueueSummaryResponse,
  StudioContextResponse,
  VideoProductionListItemResponse,
  VideoProductionResponse,
  VideoProductionSourceInput,
  VideoProductionSubmitResponse,
  WorkflowStepEventResponse,
} from "@lyonix/contracts";

export type AutoProfileSetupRequest = {
  name: string;
  contentAccountId: string;
  voiceAccountId: string;
  voiceId: string;
  mediaAccountId: string;
  renderAccountId: string;
  templateSnapshotId: string;
  locale?: string;
  durationSec?: number;
  sceneCount?: number;
};

export type AutoProfileSetupResponse = { projectId: string; automationProfileId: string };

export async function setupAutoProfile(input: AutoProfileSetupRequest): Promise<AutoProfileSetupResponse> {
  return api<AutoProfileSetupResponse>("/video-productions/auto-setup", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify(input),
  });
}

/** `backgroundSegments` (VE2E-40) is optional; omitted = server default `{ mode: "auto" }`. */
export async function submitVideoProduction(
  projectId: string,
  automationProfileId: string,
  source: VideoProductionSourceInput,
  backgroundSegments?: BackgroundSegmentsSetting,
): Promise<VideoProductionSubmitResponse> {
  return api<VideoProductionSubmitResponse>("/video-productions", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ mode: "auto", projectId, automationProfileId, source, ...(backgroundSegments ? { backgroundSegments } : {}) }),
  });
}

export async function getVideoProduction(id: string): Promise<VideoProductionResponse> {
  return api<VideoProductionResponse>(`/video-productions/${id}`);
}

/**
 * VE2E-22: every Auto run the caller themselves created (across all of their
 * self-provisioned projects) — `apps/api`'s `GET /video-productions` (already merged to
 * `dev` outside this pipeline, `VideoProductionsService.list()`) is the fix for a run
 * otherwise having no way to be found again after navigating away from its one-time submit
 * URL. `projectId` stays supported for a caller that already knows which project it wants,
 * but is intentionally omitted here.
 */
export async function listVideoProductions(): Promise<VideoProductionListItemResponse[]> {
  return api<VideoProductionListItemResponse[]>("/video-productions");
}

export async function deleteVideoProduction(id: string): Promise<void> {
  await api(`/video-productions/${id}`, { method: "DELETE", headers: await csrfHeaders() });
}

export async function retryVideoProduction(id: string): Promise<void> {
  await api(`/video-productions/${id}/retry`, { method: "POST", headers: await csrfHeaders() });
}

/** VE2E-62: take a run that is still waiting in the queue out of it (409 once a worker already claimed it). */
export async function cancelQueuedVideoProduction(id: string): Promise<void> {
  await api(`/video-productions/${id}/cancel`, { method: "POST", headers: await csrfHeaders() });
}

/** VE2E-62: `[{kind, active, limit, queued}]` for the workflow / render / media queues. */
export async function fetchQueueSummary(): Promise<QueueSummaryResponse[]> {
  return api<QueueSummaryResponse[]>("/queue-summary");
}

export async function listVideoProductionEvents(id: string): Promise<WorkflowStepEventResponse[]> {
  return api<WorkflowStepEventResponse[]>(`/video-productions/${id}/events`);
}

/** "Mở trong Studio" fork target — same StudioContextResponse shape as the legacy job bridge, sourced directly from the run's own Project/SourceVersion/ScriptDraftVersion. */
export async function fetchVideoProductionStudioContext(id: string): Promise<StudioContextResponse> {
  return api<StudioContextResponse>(`/video-productions/${id}/studio-context`);
}
