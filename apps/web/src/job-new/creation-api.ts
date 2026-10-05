/** VE2E-124: the signed-in user's own draft of the new-job form and own creation defaults (`/me/...`). No provider call, no cost. */
import { api, csrfHeaders } from "../api";
import type { CreationPreferenceOptions, CreationPreferencesResponse, JobNewFormValues, UserDraftResponse } from "@lyonix/contracts";

const DRAFT_PATH = "/me/drafts/job_new";

export const getJobNewDraft = (): Promise<UserDraftResponse | null> => api<UserDraftResponse | null>(DRAFT_PATH);

export async function saveJobNewDraft(payload: Partial<JobNewFormValues>, baseVersion: number | null): Promise<UserDraftResponse> {
  return api<UserDraftResponse>(DRAFT_PATH, { method: "PUT", headers: await csrfHeaders(), body: JSON.stringify({ payload, baseVersion }) });
}

export async function deleteJobNewDraft(): Promise<void> {
  await api<{ deleted: boolean }>(DRAFT_PATH, { method: "DELETE", headers: await csrfHeaders() });
}

export const getCreationPreferences = (): Promise<CreationPreferencesResponse | null> => api<CreationPreferencesResponse | null>("/me/creation-preferences");

export async function saveCreationPreferences(options: CreationPreferenceOptions): Promise<CreationPreferencesResponse> {
  return api<CreationPreferencesResponse>("/me/creation-preferences", { method: "PUT", headers: await csrfHeaders(), body: JSON.stringify({ options }) });
}

export async function resetCreationPreferences(): Promise<void> {
  await api<{ reset: true }>("/me/creation-preferences", { method: "DELETE", headers: await csrfHeaders() });
}
