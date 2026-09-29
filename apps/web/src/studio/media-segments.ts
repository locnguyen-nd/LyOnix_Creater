import type { MediaPlanResponse, TimelineSegmentResponse } from "@lyonix/contracts";
import type { TimelineSceneDraftForSave } from "./timeline-save";

type Scene = TimelineSceneDraftForSave & { mediaLabel?: string | null };

/** Apply the server's shared Auto/Studio plan without discarding narration, captions or edits. */
export function applyMediaPlan<S extends Scene>(scenes: S[], plan: MediaPlanResponse): { scenes: S[]; segments: TimelineSegmentResponse[] } {
  const bindings = new Map(plan.scenes.map((scene) => [scene.sceneId, scene]));
  return {
    scenes: scenes.map((scene) => {
      const binding = bindings.get(scene.sceneId);
      return binding ? { ...scene, mediaAssetVersionId: binding.mediaAssetVersionId, mediaLabel: null, segmentId: binding.segmentId, sourceStartMs: binding.sourceStartMs, sourceDurationMs: binding.sourceDurationMs } : scene;
    }),
    segments: plan.segments.map((segment) => ({ ...segment, mediaAssetVersionId: segment.mediaAssetVersionId ?? null, subject: segment.subject ?? null, priority: segment.priority ?? null })),
  };
}

/** Replace one whole segment source and restart its contiguous clip at the selected in-point. */
export function replaceSegmentSource<S extends Scene>(
  scenes: S[], segments: TimelineSegmentResponse[], segmentId: string, asset: { id: string; kind: "video" | "image"; durationMs: number | null }, inPointMs = 0,
): { scenes: S[]; segments: TimelineSegmentResponse[] } {
  const segment = segments.find((row) => row.segmentId === segmentId);
  if (!segment) return { scenes, segments };
  let cursor = Math.max(0, Math.floor(inPointMs));
  if (asset.kind === "video" && asset.durationMs) cursor = Math.min(cursor, Math.max(0, asset.durationMs - 1));
  const memberIds = new Set(segment.sceneIds);
  const updated = scenes.map((scene) => {
    if (!memberIds.has(scene.sceneId)) return scene;
    const duration = scene.sourceDurationMs;
    if (asset.kind !== "video" || !duration || !asset.durationMs) {
      return { ...scene, mediaAssetVersionId: asset.id, mediaLabel: null, sourceStartMs: null, sourceDurationMs: null };
    }
    if (cursor >= asset.durationMs) cursor = 0;
    const available = asset.durationMs - cursor;
    const rangeDuration = Math.min(duration, available);
    const next = { ...scene, mediaAssetVersionId: asset.id, mediaLabel: null, sourceStartMs: cursor, sourceDurationMs: rangeDuration };
    cursor += rangeDuration;
    return next;
  });
  return {
    scenes: updated,
    segments: segments.map((row) => row.segmentId === segmentId ? { ...row, mediaAssetVersionId: asset.id } : row),
  };
}
