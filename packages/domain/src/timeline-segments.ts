/**
 * VE2E-42: pure structural rules for the shared timeline contract's background segments and
 * per-scene source ranges (CR-JP-ONESHOT-MEDIA-2026-09-29 §4/§8). No I/O: the API
 * (`timeline-versions.service.ts`) runs `validateTimelineSegmentStructure` before it checks
 * ids against the database, and Studio runs `normalizeTimelineSegments` before saving so a
 * user edit (reorder, media swap) never produces a timeline the API would reject.
 *
 * Everything here is optional/additive: a timeline with no `segments` and no ranges (every
 * timeline saved before VE2E-42) is always valid and normalizes to itself.
 *
 * Types are structural (this package has no dependency on `@lyonix/contracts`); they match
 * `TimelineSceneBindingInput`/`TimelineSegmentInput` field-for-field.
 */

export const TIMELINE_SEGMENT_ID_MAX_LENGTH = 100;
export const TIMELINE_SEGMENT_SUBJECT_MAX_LENGTH = 200;
export const TIMELINE_SEGMENT_PRIORITY_MIN = 1;
export const TIMELINE_SEGMENT_PRIORITY_MAX = 10;
/** Upper bound for a source offset/duration (6h) - guards against garbage values, not a product limit. */
export const TIMELINE_SOURCE_RANGE_MAX_MS = 6 * 60 * 60 * 1000;

export type TimelineSceneRangeLike = {
  sceneId: string;
  mediaAssetVersionId?: string | null;
  segmentId?: string | null;
  sourceStartMs?: number | null;
  sourceDurationMs?: number | null;
};

export type TimelineSegmentLike = {
  segmentId: string;
  sceneIds: string[];
  mediaAssetVersionId?: string | null;
  subject?: string | null;
  priority?: number | null;
};

export type TimelineStructureResult = { ok: true } | { ok: false; message: string };

const isNonNegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Checks, in timeline order:
 * - each scene's range: both-or-neither of `sourceStartMs`/`sourceDurationMs`, integers, start >= 0,
 *   duration > 0, both bounded, and only on a scene that has a bound media asset;
 * - each segment: non-empty unique id (bounded length), non-empty `sceneIds` naming existing
 *   scenes, a scene in at most one segment, `sceneIds` consecutive in timeline order and listed
 *   in that order, optional subject length / integer priority in range;
 * - consistency: a scene's `segmentId` (when set) names a segment that lists it, and every scene
 *   a segment lists carries that `segmentId`.
 *
 * Media-kind (range only on `video`) and "range within the source's duration" need the asset row,
 * so they are checked by the API against the database, not here.
 */
export function validateTimelineSegmentStructure(scenes: TimelineSceneRangeLike[], segments: TimelineSegmentLike[] | null | undefined): TimelineStructureResult {
  for (const scene of scenes) {
    const start = scene.sourceStartMs ?? null;
    const duration = scene.sourceDurationMs ?? null;
    if ((start === null) !== (duration === null)) return { ok: false, message: `Scene ${scene.sceneId}: sourceStartMs và sourceDurationMs phải cùng có hoặc cùng trống` };
    if (start !== null && duration !== null) {
      if (!isNonNegativeInt(start) || start > TIMELINE_SOURCE_RANGE_MAX_MS) return { ok: false, message: `Scene ${scene.sceneId}: sourceStartMs không hợp lệ` };
      if (!isNonNegativeInt(duration) || duration === 0 || duration > TIMELINE_SOURCE_RANGE_MAX_MS) return { ok: false, message: `Scene ${scene.sceneId}: sourceDurationMs không hợp lệ` };
      if (!scene.mediaAssetVersionId) return { ok: false, message: `Scene ${scene.sceneId}: có dải nguồn nhưng chưa gắn media` };
    }
    if (scene.segmentId !== undefined && scene.segmentId !== null) {
      if (typeof scene.segmentId !== "string" || !scene.segmentId.trim() || scene.segmentId.length > TIMELINE_SEGMENT_ID_MAX_LENGTH) {
        return { ok: false, message: `Scene ${scene.sceneId}: segmentId không hợp lệ` };
      }
    }
  }

  const list = segments ?? [];
  if (!Array.isArray(list)) return { ok: false, message: "segments phải là mảng" };
  const indexBySceneId = new Map(scenes.map((scene, index) => [scene.sceneId, index]));
  const segmentBySceneId = new Map<string, string>();
  const segmentIds = new Set<string>();
  for (const segment of list) {
    const segmentId = typeof segment?.segmentId === "string" ? segment.segmentId.trim() : "";
    if (!segmentId || segmentId.length > TIMELINE_SEGMENT_ID_MAX_LENGTH) return { ok: false, message: "segmentId không hợp lệ" };
    if (segmentIds.has(segmentId)) return { ok: false, message: `segmentId trùng lặp: ${segmentId}` };
    segmentIds.add(segmentId);
    if (!Array.isArray(segment.sceneIds) || segment.sceneIds.length === 0) return { ok: false, message: `Segment ${segmentId} cần ít nhất một scene` };
    let previousIndex = -1;
    for (const sceneId of segment.sceneIds) {
      const index = typeof sceneId === "string" ? indexBySceneId.get(sceneId) : undefined;
      if (index === undefined) return { ok: false, message: `Segment ${segmentId} tham chiếu scene không có trong timeline: ${String(sceneId)}` };
      if (segmentBySceneId.has(sceneId)) return { ok: false, message: `Scene ${sceneId} thuộc nhiều segment` };
      if (previousIndex !== -1 && index !== previousIndex + 1) return { ok: false, message: `Segment ${segmentId} phải gồm các scene liên tiếp theo thứ tự timeline` };
      previousIndex = index;
      segmentBySceneId.set(sceneId, segmentId);
    }
    if (segment.mediaAssetVersionId !== undefined && segment.mediaAssetVersionId !== null && typeof segment.mediaAssetVersionId !== "string") {
      return { ok: false, message: `Segment ${segmentId}: mediaAssetVersionId không hợp lệ` };
    }
    if (segment.subject !== undefined && segment.subject !== null && (typeof segment.subject !== "string" || segment.subject.length > TIMELINE_SEGMENT_SUBJECT_MAX_LENGTH)) {
      return { ok: false, message: `Segment ${segmentId}: subject không hợp lệ` };
    }
    if (segment.priority !== undefined && segment.priority !== null) {
      const priority = segment.priority;
      if (typeof priority !== "number" || !Number.isInteger(priority) || priority < TIMELINE_SEGMENT_PRIORITY_MIN || priority > TIMELINE_SEGMENT_PRIORITY_MAX) {
        return { ok: false, message: `Segment ${segmentId}: priority phải là số nguyên ${TIMELINE_SEGMENT_PRIORITY_MIN}..${TIMELINE_SEGMENT_PRIORITY_MAX}` };
      }
    }
  }

  for (const scene of scenes) {
    const declared = scene.segmentId?.trim() || null;
    const listedIn = segmentBySceneId.get(scene.sceneId) ?? null;
    if (declared !== listedIn) {
      return declared
        ? { ok: false, message: `Scene ${scene.sceneId} ghi segmentId ${declared} nhưng segment đó không chứa scene này` }
        : { ok: false, message: `Scene ${scene.sceneId} được segment ${listedIn} liệt kê nhưng thiếu segmentId` };
    }
  }
  return { ok: true };
}

/**
 * Repairs a Studio draft so it satisfies `validateTimelineSegmentStructure` after an arbitrary
 * user edit, without inventing any plan: a segment whose member scenes are no longer present
 * or no longer consecutive (e.g. after a reorder) is dropped entirely and its scenes lose their
 * `segmentId`; a scene's dangling `segmentId` is cleared; an incomplete range is cleared. Never
 * adds segments or ranges. Returns new arrays; inputs are not mutated.
 */
export function normalizeTimelineSegments<S extends TimelineSceneRangeLike, G extends TimelineSegmentLike>(
  scenes: S[],
  segments: G[] | null | undefined,
): { scenes: S[]; segments: G[] } {
  const indexBySceneId = new Map(scenes.map((scene, index) => [scene.sceneId, index]));
  const claimed = new Set<string>();
  const seenIds = new Set<string>();
  const kept: G[] = [];
  for (const segment of segments ?? []) {
    const segmentId = segment.segmentId?.trim();
    if (!segmentId || seenIds.has(segmentId)) continue;
    const indexes = segment.sceneIds.map((sceneId) => indexBySceneId.get(sceneId));
    const valid =
      indexes.length > 0 &&
      indexes.every((index, i): index is number => index !== undefined && (i === 0 || index === indexes[i - 1]! + 1)) &&
      segment.sceneIds.every((sceneId) => !claimed.has(sceneId) && scenes[indexBySceneId.get(sceneId)!]!.segmentId?.trim() === segmentId);
    if (!valid) continue;
    seenIds.add(segmentId);
    for (const sceneId of segment.sceneIds) claimed.add(sceneId);
    kept.push(segment);
  }
  const segmentOf = new Map<string, string>();
  for (const segment of kept) for (const sceneId of segment.sceneIds) segmentOf.set(sceneId, segment.segmentId.trim());
  const fixedScenes = scenes.map((scene) => {
    const hasRange = scene.sourceStartMs != null && scene.sourceDurationMs != null && Boolean(scene.mediaAssetVersionId);
    return {
      ...scene,
      segmentId: segmentOf.get(scene.sceneId) ?? null,
      sourceStartMs: hasRange ? scene.sourceStartMs! : null,
      sourceDurationMs: hasRange ? scene.sourceDurationMs! : null,
    };
  });
  return { scenes: fixedScenes, segments: kept };
}
