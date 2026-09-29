/**
 * VE2E-38: Studio-side read of the script's optional `visualPlan` (from the studio context).
 * Mirrors `mediaSearchQueryForScene` in `@lyonix/providers` (not imported here: that package is
 * server-side) so Studio's Pexels search uses the same query the Auto runner uses - the scene's
 * segment `keywords.en` when present, otherwise the scene's own `visualQuery` exactly as before.
 * Segment UI / re-plan / ja keyword search are VE2E-41.
 */
import type { ScriptVisualPlanResponse, ScriptVisualSegmentResponse } from "@lyonix/contracts";

export function visualSegmentForScene(plan: ScriptVisualPlanResponse | null | undefined, sceneId: string): ScriptVisualSegmentResponse | null {
  return plan?.segments.find((segment) => segment.sceneIds.includes(sceneId)) ?? null;
}

export function pexelsQueryForScene(scene: { sceneId: string; visualQuery: string }, plan: ScriptVisualPlanResponse | null | undefined): string {
  const english = visualSegmentForScene(plan, scene.sceneId)?.keywords.en.trim();
  return english || scene.visualQuery;
}
