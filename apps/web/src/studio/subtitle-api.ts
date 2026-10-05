/** V03-03: typed client for editing one voice's timed subtitles (`/audio-versions/:id/subtitle-versions`). */
import { api, csrfHeaders } from "../api";
import type { ResetSubtitleVersionRequest, SaveSubtitleVersionRequest, SubtitleVersionResponse } from "@lyonix/contracts";

export async function listSubtitleVersions(audioVersionId: string): Promise<SubtitleVersionResponse[]> {
  return api<SubtitleVersionResponse[]>(`/audio-versions/${audioVersionId}/subtitle-versions`);
}

export async function saveSubtitleVersion(audioVersionId: string, body: SaveSubtitleVersionRequest): Promise<SubtitleVersionResponse> {
  return api<SubtitleVersionResponse>(`/audio-versions/${audioVersionId}/subtitle-versions`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(body) });
}

export async function resetSubtitleVersion(audioVersionId: string, body: ResetSubtitleVersionRequest): Promise<SubtitleVersionResponse> {
  return api<SubtitleVersionResponse>(`/audio-versions/${audioVersionId}/subtitle-versions/reset`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(body) });
}
