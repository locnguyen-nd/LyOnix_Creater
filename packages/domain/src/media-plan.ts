/**
 * VE2E-31 (CR-JP-ONESHOT-MEDIA-2026-09-29 §4/§8): pure planning half of the one-shot background
 * media plan. No I/O - `apps/api/src/media-plan.service.ts` does the sourcing (Pexels search/rank/
 * moderation/import) and calls these functions before/after it.
 *
 * 1. `planBackgroundSegments` groups the script's scenes into background segments: the script's
 *    own `visualPlan` (VE2E-38) when it has one, adjusted to the run's segment-count range
 *    (VE2E-40) without ever splitting the main subject (priority 1); otherwise a deterministic
 *    duration-balanced grouping of consecutive scenes.
 * 2. `computeSegmentSourceRanges` cuts one source clip into contiguous, non-overlapping per-scene
 *    ranges sized by each scene's real voice duration, so footage runs on across scene boundaries.
 *
 * Every number marked PLACEHOLDER is untuned (same honesty rule as MEDIA_RELEVANCE_THRESHOLD):
 * Test/owner tune it against the VE2E-39 benchmark; Code does not claim these are right.
 */

export const MEDIA_PLAN_POLICY_VERSION = "media-plan-policy.v1";

/** PLACEHOLDER (untuned, CR §4 "~6s"): preferred minimum length of a background segment. Not applied to the first (hook) segment. */
export const MEDIA_PLAN_MIN_SEGMENT_MS = 6_000;
/** PLACEHOLDER (untuned, CR §4 "~20s"): preferred maximum length of a background segment. */
export const MEDIA_PLAN_MAX_SEGMENT_MS = 20_000;

export type MediaPlanScene = {
  sceneId: string;
  /** Real voice duration for the scene (AudioVersion.durationMs); callers fall back to the script's durationHintMs only when no audio exists yet. */
  durationMs: number;
};

export type MediaPlanVisualSegment = {
  segmentId: string;
  sceneIds: string[];
  subject: string;
  priority: number;
  keywords: { ja: string; en: string };
};

export type PlannedSegment = {
  segmentId: string;
  sceneIds: string[];
  subject: string | null;
  /** 1 = main subject; `null` for fallback groups (no plan to say). */
  priority: number | null;
  keywords: { ja: string; en: string } | null;
  durationMs: number;
  origin: "visual_plan" | "fallback";
};

export type SegmentCountRange = { min: number; max: number };

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * How many segments a duration-balanced fallback grouping uses: inside `range` (clamped to the
 * scene count), the smallest count whose average segment fits under MAX, but not so many that the
 * average drops under MIN (unless `range.min` forces it).
 */
export function chooseFallbackSegmentCount(totalMs: number, sceneCount: number, range: SegmentCountRange | null): number {
  if (sceneCount <= 0) return 0;
  const lo = Math.min(Math.max(1, range?.min ?? 1), sceneCount);
  const hi = Math.min(Math.max(lo, range?.max ?? sceneCount), sceneCount);
  let count = lo;
  while (count < hi && totalMs / count > MEDIA_PLAN_MAX_SEGMENT_MS && totalMs / (count + 1) >= MEDIA_PLAN_MIN_SEGMENT_MS) count += 1;
  return count;
}

/** Splits consecutive scenes into `count` groups with cumulative-duration boundaries as even as possible (deterministic). */
export function groupScenesByDuration(scenes: MediaPlanScene[], count: number): MediaPlanScene[][] {
  if (scenes.length === 0 || count <= 0) return [];
  const groups = Math.min(count, scenes.length);
  const total = sum(scenes.map((s) => Math.max(0, s.durationMs)));
  const result: MediaPlanScene[][] = [];
  let index = 0;
  let consumed = 0;
  for (let g = 0; g < groups; g += 1) {
    const remainingGroups = groups - g;
    const group: MediaPlanScene[] = [];
    if (remainingGroups === 1) {
      group.push(...scenes.slice(index));
      index = scenes.length;
    } else {
      const target = (total * (g + 1)) / groups;
      // Always take at least one scene, and leave at least one scene for each remaining group.
      while (index < scenes.length - (remainingGroups - 1)) {
        const scene = scenes[index]!;
        const next = consumed + Math.max(0, scene.durationMs);
        if (group.length > 0 && Math.abs(next - target) > Math.abs(consumed - target)) break;
        group.push(scene);
        consumed = next;
        index += 1;
      }
    }
    result.push(group);
  }
  return result;
}

const toPlanned = (segment: MediaPlanVisualSegment, durations: Map<string, number>): PlannedSegment => ({
  segmentId: segment.segmentId,
  sceneIds: [...segment.sceneIds],
  subject: segment.subject || null,
  priority: segment.priority,
  keywords: { ja: segment.keywords.ja, en: segment.keywords.en },
  durationMs: sum(segment.sceneIds.map((id) => durations.get(id) ?? 0)),
  origin: "visual_plan",
});

const isMainSubject = (segment: PlannedSegment) => segment.priority === 1;

/**
 * Adjusts a (valid, full-coverage) visual plan to `range`:
 * - too many segments: repeatedly merge the adjacent pair with the smallest combined duration,
 *   preferring pairs that do not involve a main-subject segment; the merged segment keeps the
 *   higher-priority side's subject/keywords/id (merging never splits a subject).
 * - too few: repeatedly split the longest non-main-subject segment with >= 2 scenes at the scene
 *   boundary nearest its duration midpoint (second half id `<id>-b`, same keywords). If only
 *   main-subject segments remain splittable, the count stays below `range.min` - keeping the main
 *   subject whole wins over the count (CR §4).
 */
export function fitSegmentsToRange(segments: PlannedSegment[], range: SegmentCountRange | null, durations: Map<string, number>): PlannedSegment[] {
  if (!range) return segments;
  let result = segments.map((s) => ({ ...s, sceneIds: [...s.sceneIds] }));
  while (result.length > range.max && result.length > 1) {
    let best = -1;
    let bestKey: [number, number] | null = null;
    for (let i = 0; i < result.length - 1; i += 1) {
      const a = result[i]!;
      const b = result[i + 1]!;
      const key: [number, number] = [isMainSubject(a) || isMainSubject(b) ? 1 : 0, a.durationMs + b.durationMs];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        bestKey = key;
        best = i;
      }
    }
    const a = result[best]!;
    const b = result[best + 1]!;
    const keep = (b.priority ?? Number.MAX_SAFE_INTEGER) < (a.priority ?? Number.MAX_SAFE_INTEGER) ? b : a;
    const merged: PlannedSegment = { ...keep, sceneIds: [...a.sceneIds, ...b.sceneIds], durationMs: a.durationMs + b.durationMs };
    result = [...result.slice(0, best), merged, ...result.slice(best + 2)];
  }
  while (result.length < range.min) {
    let best = -1;
    for (let i = 0; i < result.length; i += 1) {
      const candidate = result[i]!;
      if (isMainSubject(candidate) || candidate.sceneIds.length < 2) continue;
      if (best === -1 || candidate.durationMs > result[best]!.durationMs) best = i;
    }
    if (best === -1) break;
    const target = result[best]!;
    const sceneDurations = target.sceneIds.map((id) => durations.get(id) ?? 0);
    let cut = 1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let k = 1; k < target.sceneIds.length; k += 1) {
      const gap = Math.abs(sum(sceneDurations.slice(0, k)) - target.durationMs / 2);
      if (gap < bestGap) {
        bestGap = gap;
        cut = k;
      }
    }
    const first: PlannedSegment = { ...target, sceneIds: target.sceneIds.slice(0, cut), durationMs: sum(sceneDurations.slice(0, cut)) };
    const second: PlannedSegment = { ...target, segmentId: `${target.segmentId}-b`, sceneIds: target.sceneIds.slice(cut), durationMs: sum(sceneDurations.slice(cut)) };
    result = [...result.slice(0, best), first, second, ...result.slice(best + 1)];
  }
  return result;
}

/** Whether a visual plan covers exactly these scenes, in order, as consecutive runs (the VE2E-38 normalizer already guarantees this for a parsed plan; re-checked here because the scene list may have changed since). */
const coversScenesInOrder = (plan: MediaPlanVisualSegment[], sceneIds: string[]) => {
  const flattened = plan.flatMap((segment) => segment.sceneIds);
  return flattened.length === sceneIds.length && flattened.every((id, index) => id === sceneIds[index]) && plan.every((segment) => segment.sceneIds.length > 0);
};

export function planBackgroundSegments(
  scenes: MediaPlanScene[],
  visualPlan: { segments: MediaPlanVisualSegment[] } | null | undefined,
  range: SegmentCountRange | null,
): PlannedSegment[] {
  if (scenes.length === 0) return [];
  const durations = new Map(scenes.map((scene) => [scene.sceneId, Math.max(0, scene.durationMs)]));
  const sceneIds = scenes.map((scene) => scene.sceneId);
  if (visualPlan && visualPlan.segments.length > 0 && coversScenesInOrder(visualPlan.segments, sceneIds)) {
    return fitSegmentsToRange(visualPlan.segments.map((segment) => toPlanned(segment, durations)), range, durations);
  }
  const count = chooseFallbackSegmentCount(sum([...durations.values()]), scenes.length, range);
  return groupScenesByDuration(scenes, count).map((group, index) => ({
    segmentId: `seg-${index + 1}`,
    sceneIds: group.map((scene) => scene.sceneId),
    subject: null,
    priority: null,
    keywords: null,
    durationMs: sum(group.map((scene) => Math.max(0, scene.durationMs))),
    origin: "fallback",
  }));
}

export type SceneSourceRange = { sceneId: string; sourceStartMs: number; sourceDurationMs: number; looped: boolean; short: boolean };

/**
 * Contiguous, non-overlapping per-scene ranges inside one source clip, in scene order, each sized
 * to the scene's voice duration.
 *
 * Source-too-short policy (chosen for v1, documented, CR §4 allowed "loop hoặc phủ bằng clip thứ
 * 2"): LOOP AT A SCENE BOUNDARY. When the next scene no longer fits in what is left of the source,
 * it restarts from 0 (`looped: true`) - the jump back happens only at a scene cut, never mid-scene,
 * and costs no extra provider search/import. A single scene longer than the whole source gets the
 * whole source (`short: true`, range shorter than the voice). A second same-keyword clip was not
 * chosen: it doubles search/import/moderation per short segment and still needs a policy for when
 * that clip is short too. Revisit after the VE2E-39 benchmark.
 *
 * Returns `null` when the source duration is unknown/non-positive (e.g. a photo, or a legacy asset
 * without duration) - callers then bind the asset without ranges, exactly as before VE2E-31.
 */
export function computeSegmentSourceRanges(scenes: MediaPlanScene[], sourceDurationMs: number | null | undefined): SceneSourceRange[] | null {
  if (typeof sourceDurationMs !== "number" || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) return null;
  const source = Math.floor(sourceDurationMs);
  const ranges: SceneSourceRange[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    const wanted = Math.max(1, Math.round(scene.durationMs));
    if (wanted >= source) {
      ranges.push({ sceneId: scene.sceneId, sourceStartMs: 0, sourceDurationMs: source, looped: cursor > 0, short: wanted > source });
      cursor = source;
      continue;
    }
    let looped = false;
    if (cursor + wanted > source) {
      cursor = 0;
      looped = true;
    }
    ranges.push({ sceneId: scene.sceneId, sourceStartMs: cursor, sourceDurationMs: wanted, looped, short: false });
    cursor += wanted;
  }
  return ranges;
}
