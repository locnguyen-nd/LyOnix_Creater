/**
 * VE2E-08: typed client for the Auto "one-click" entry (spec §7 "Auto entry") — provisions
 * the Project/AutomationProfileVersion a submit needs, then drives the VE2E-06
 * `POST /video-productions` DAG and polls its live status/events.
 */
import { api, csrfHeaders } from "./api";
import type { StudioContextResponse, VideoProductionResponse, VideoProductionSourceInput, VideoProductionSubmitResponse, WorkflowStepEventResponse } from "@lyonix/contracts";

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

export async function submitVideoProduction(projectId: string, automationProfileId: string, source: VideoProductionSourceInput): Promise<VideoProductionSubmitResponse> {
  return api<VideoProductionSubmitResponse>("/video-productions", {
    method: "POST",
    headers: await csrfHeaders(),
    body: JSON.stringify({ mode: "auto", projectId, automationProfileId, source }),
  });
}

export async function getVideoProduction(id: string): Promise<VideoProductionResponse> {
  return api<VideoProductionResponse>(`/video-productions/${id}`);
}

export async function listVideoProductionEvents(id: string): Promise<WorkflowStepEventResponse[]> {
  return api<WorkflowStepEventResponse[]>(`/video-productions/${id}/events`);
}

/** "Mở trong Studio" fork target — same StudioContextResponse shape as the legacy job bridge, sourced directly from the run's own Project/SourceVersion/ScriptDraftVersion. */
export async function fetchVideoProductionStudioContext(id: string): Promise<StudioContextResponse> {
  return api<StudioContextResponse>(`/video-productions/${id}/studio-context`);
}
