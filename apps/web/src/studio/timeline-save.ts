/**
 * VE2E-42: Studio's save payload for the shared timeline contract. Studio has no segment UI yet
 * (VE2E-41), but it must not silently drop the segment plan / source ranges an Auto run (or a
 * later Media Plan) persisted when the user edits and re-saves - that would change what the next
 * render cuts. It carries them through untouched, and repairs whatever a user edit made
 * structurally invalid (a reorder that splits a segment, a range left on a scene whose media was
 * removed) with the same pure rules the API validates against, so a save never fails on them.
 */
// Browser-safe subpath, not the bare `@lyonix/domain` barrel (see media-selection.ts for why).
import { normalizeTimelineSegments } from "@lyonix/domain/timeline-segments";
import type { TimelineSceneBindingInput, TimelineSegmentInput, TimelineSegmentResponse } from "@lyonix/contracts";

export type TimelineSceneDraftForSave = {
  sceneId: string;
  mediaAssetVersionId: string | null;
  audioVersionId: string | null;
  subtitleVersionId: string | null;
  screenTextOverride: string | null;
  annotation: string | null;
  excluded: boolean;
  segmentId: string | null;
  sourceStartMs: number | null;
  sourceDurationMs: number | null;
};

export function buildTimelineSaveScenes(
  scenes: TimelineSceneDraftForSave[],
  segments: TimelineSegmentResponse[],
): { scenes: TimelineSceneBindingInput[]; segments: TimelineSegmentInput[] } {
  const normalized = normalizeTimelineSegments(scenes, segments);
  return {
    scenes: normalized.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      mediaAssetVersionId: scene.mediaAssetVersionId,
      audioVersionId: scene.audioVersionId,
      subtitleVersionId: scene.subtitleVersionId,
      screenTextOverride: scene.screenTextOverride,
      annotation: scene.annotation,
      excluded: scene.excluded,
      segmentId: scene.segmentId ?? null,
      sourceStartMs: scene.sourceStartMs ?? null,
      sourceDurationMs: scene.sourceDurationMs ?? null,
    })),
    segments: normalized.segments.map((segment) => ({
      segmentId: segment.segmentId,
      sceneIds: segment.sceneIds,
      mediaAssetVersionId: segment.mediaAssetVersionId,
      subject: segment.subject,
      priority: segment.priority,
    })),
  };
}

/** A source range belongs to the clip it was cut from: swapping a scene's media drops its range (the segment membership stays). */
export function withMediaAssigned<S extends TimelineSceneDraftForSave>(scene: S, mediaAssetVersionId: string): S {
  if (scene.mediaAssetVersionId === mediaAssetVersionId) return scene;
  return { ...scene, mediaAssetVersionId, sourceStartMs: null, sourceDurationMs: null };
}
