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

/**
 * Remove one scene from its segment. The scene loses `segmentId` and its source range. Remaining
 * members stay consecutive: removing a middle scene splits the segment in two (the tail gets a new
 * unique id and keeps its own per-scene ranges); a segment left with no scenes is removed.
 */
export function detachSceneFromSegment<S extends Scene>(
  scenes: S[], segments: TimelineSegmentResponse[], sceneId: string,
): { scenes: S[]; segments: TimelineSegmentResponse[] } {
  const segment = segments.find((row) => row.sceneIds.includes(sceneId));
  const scene = scenes.find((row) => row.sceneId === sceneId);
  if (!segment || !scene) return { scenes, segments };
  const at = segment.sceneIds.indexOf(sceneId);
  const head = segment.sceneIds.slice(0, at);
  const tail = segment.sceneIds.slice(at + 1);
  const usedIds = new Set(segments.map((row) => row.segmentId));
  let tailId = `${segment.segmentId}-b`;
  for (let n = 2; usedIds.has(tailId); n += 1) tailId = `${segment.segmentId}-b${n}`;
  const nextSegments: TimelineSegmentResponse[] = [];
  for (const row of segments) {
    if (row.segmentId !== segment.segmentId) { nextSegments.push(row); continue; }
    if (head.length) nextSegments.push({ ...row, sceneIds: head });
    if (tail.length) nextSegments.push({ ...row, segmentId: head.length ? tailId : row.segmentId, sceneIds: tail });
  }
  const tailSet = new Set(head.length ? tail : []);
  return {
    scenes: scenes.map((row) => {
      if (row.sceneId === sceneId) return { ...row, segmentId: null, sourceStartMs: null, sourceDurationMs: null };
      return tailSet.has(row.sceneId) ? { ...row, segmentId: tailId } : row;
    }),
    segments: nextSegments,
  };
}

/** Assign media to exactly one scene: detach it from its segment, then bind the new source (no range). */
export function assignSceneOnly<S extends Scene>(
  scenes: S[], segments: TimelineSegmentResponse[], sceneId: string, asset: { id: string; label: string | null },
): { scenes: S[]; segments: TimelineSegmentResponse[] } {
  const detached = detachSceneFromSegment(scenes, segments, sceneId);
  return {
    segments: detached.segments,
    scenes: detached.scenes.map((scene) => scene.sceneId === sceneId
      ? { ...scene, mediaAssetVersionId: asset.id, mediaLabel: asset.label, sourceStartMs: null, sourceDurationMs: null }
      : scene),
  };
}

/**
 * True when an in-point leaves less footage than the segment's scenes need, i.e. replaceSegmentSource
 * would shorten a range or wrap back to 0 (repeated footage).
 */
export function inPointShortfall(
  scenes: Scene[], segment: TimelineSegmentResponse, assetDurationMs: number | null, inPointMs: number,
): { shortByMs: number } | null {
  if (!assetDurationMs) return null;
  const needed = scenes.filter((scene) => segment.sceneIds.includes(scene.sceneId)).reduce((sum, scene) => sum + (scene.sourceDurationMs ?? 0), 0);
  const cursor = Math.min(Math.max(0, Math.floor(inPointMs)), Math.max(0, assetDurationMs - 1));
  const shortByMs = needed - (assetDurationMs - cursor);
  return shortByMs > 0 ? { shortByMs } : null;
}
