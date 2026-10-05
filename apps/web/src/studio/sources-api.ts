import { api } from "../api";
import type { SourceVersionSummary } from "@lyonix/contracts";

export async function listProjectSources(projectId: string): Promise<SourceVersionSummary[]> {
  return api<SourceVersionSummary[]>(`/projects/${projectId}/sources`);
}
