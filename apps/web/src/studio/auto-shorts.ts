import type { TimelineSegmentResponse } from "@lyonix/contracts";
import type { TimelineSceneDraftForSave } from "./timeline-save";
import { replaceSegmentSource } from "./media-segments";

/**
 * "Long video -> shorts": spreads one short window per background segment across an uploaded long video
 * (first/last guard skipped so intros/outros are not used). Pure planning; the render path already cuts each
 * scene's `sourceStartMs/sourceDurationMs` range from the asset through the media worker.
 */

export type ShortWindow = {
  segmentId: string;
  startMs: number;
  durationMs: number;
  /** false when the source is too short and this window had to be clipped/overlaps. */
  fits: boolean;
};

export type ShortsPlan = {
  windows: ShortWindow[];
  /** true when the long video cannot cover every segment without overlap (use a longer file or more sources). */
  needsMoreSource: boolean;
  usableMs: number;
  requiredMs: number;
};

export const DEFAULT_SHORTS_GUARD_START_MS = 1000;
export const DEFAULT_SHORTS_GUARD_END_MS = 1500;
const STEP_MS = 100;
const snap = (value: number) => Math.round(value / STEP_MS) * STEP_MS;

export function planShortsFromSource(input: {
  segments: readonly { segmentId: string; durationMs: number }[];
  sourceDurationMs: number;
  guardStartMs?: number;
  guardEndMs?: number;
}): ShortsPlan {
  const guardStart = Math.max(0, input.guardStartMs ?? DEFAULT_SHORTS_GUARD_START_MS);
  const guardEnd = Math.max(0, input.guardEndMs ?? DEFAULT_SHORTS_GUARD_END_MS);
  const usableMs = Math.max(0, input.sourceDurationMs - guardStart - guardEnd);
  const requiredMs = input.segments.reduce((sum, segment) => sum + Math.max(0, segment.durationMs), 0);
  const count = input.segments.length;
  if (count === 0) return { windows: [], needsMoreSource: false, usableMs, requiredMs };

  if (requiredMs <= usableMs) {
    // Spread the windows evenly (equal gaps, half a gap before the first) so the shorts come from across the whole video.
    const gap = (usableMs - requiredMs) / count;
    let cursor = guardStart + gap / 2;
    const windows = input.segments.map((segment) => {
      const startMs = snap(cursor);
      cursor += segment.durationMs + gap;
      return { segmentId: segment.segmentId, startMs, durationMs: segment.durationMs, fits: true };
    });
    return { windows, needsMoreSource: false, usableMs, requiredMs };
  }

  // Too short: lay the windows back to back from the guard; whatever does not fit is clipped and flagged.
  let cursor = guardStart;
  const end = guardStart + usableMs;
  const windows = input.segments.map((segment) => {
    const startMs = Math.min(snap(cursor), Math.max(0, end - STEP_MS));
    const durationMs = Math.max(0, Math.min(segment.durationMs, end - startMs));
    const fits = durationMs >= segment.durationMs;
    cursor += segment.durationMs;
    return { segmentId: segment.segmentId, startMs, durationMs, fits };
  });
  return { windows, needsMoreSource: true, usableMs, requiredMs };
}

type DraftScene = TimelineSceneDraftForSave & { mediaLabel?: string | null };

/** Segment length = the sum of its scenes' clip durations (fallback: the scene's duration hint). */
export function segmentDurations(
  scenes: readonly DraftScene[],
  segments: readonly TimelineSegmentResponse[],
  fallbackSceneMs: (sceneId: string) => number,
): { segmentId: string; durationMs: number }[] {
  const byId = new Map(scenes.map((scene) => [scene.sceneId, scene]));
  return segments.map((segment) => ({
    segmentId: segment.segmentId,
    durationMs: segment.sceneIds.reduce((sum, sceneId) => sum + (byId.get(sceneId)?.sourceDurationMs ?? fallbackSceneMs(sceneId)), 0),
  }));
}

/** Binds the planned windows to the segments' scenes (contiguous per-scene ranges starting at each window). */
export function applyShortsPlan<S extends DraftScene>(
  scenes: S[],
  segments: TimelineSegmentResponse[],
  asset: { id: string; durationMs: number | null },
  plan: ShortsPlan,
  fallbackSceneMs: (sceneId: string) => number,
): { scenes: S[]; segments: TimelineSegmentResponse[] } {
  const memberIds = new Set(segments.flatMap((segment) => segment.sceneIds));
  let next = { scenes: scenes.map((scene) => (memberIds.has(scene.sceneId) && !scene.sourceDurationMs ? { ...scene, sourceDurationMs: fallbackSceneMs(scene.sceneId) } : scene)), segments };
  for (const window of plan.windows) {
    next = replaceSegmentSource(next.scenes, next.segments, window.segmentId, { id: asset.id, kind: "video", durationMs: asset.durationMs }, window.startMs);
  }
  return next;
}
