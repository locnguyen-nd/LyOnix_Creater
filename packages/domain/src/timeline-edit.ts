/**
 * VE2E-58 (CR-STUDIO-EDIT-PARALLEL-2026-10-01 §3A): pure add / duplicate / remove / restore / split
 * operations on a Studio timeline. No I/O and no framework: the API validates the resulting state
 * with `validateTimelineEditState` (plus the shared `validateTimelineSegmentStructure`), and the
 * Studio UI (VE2E-59) calls the same operations for its undo-stack so both agree.
 *
 * Model (all additive - a timeline with no `addedScenes`/`removedSceneIds` behaves exactly as before):
 * - `scenes`: ordered bindings (the timeline). A scene is "in the video" iff it is listed here.
 * - `addedScenes`: definitions (narration/screenText/durationHint) of scenes the user created
 *   (`origin: "added"`) or produced by splitting (`origin: "split"`). A script scene has no
 *   definition here - the approved script stays the source of truth for it.
 * - `removedSceneIds`: script-origin scenes dropped from the timeline. Recoverable (`restoreScene`);
 *   script data is never touched. Removing an added/split scene deletes it for good (its
 *   definition is dropped too).
 *
 * Voice: a scene created by add/duplicate/split never carries audio (`audioVersionId`/
 * `subtitleVersionId` = null). Reusing the original voice for different text would be wrong, and
 * the existing "Sinh giọng" flow only generates for scenes missing audio, so nothing is paid twice.
 */
import { splitIntoSentences } from "./caption-segmentation.js";
import type { CaptionTextStylePatch } from "./caption-style.js";
import {
  normalizeTimelineSegments,
  TIMELINE_SOURCE_RANGE_MAX_MS,
  validateTimelineSegmentStructure,
  type TimelineSceneRangeLike,
  type TimelineSegmentLike,
} from "./timeline-segments.js";

export const TIMELINE_ADDED_SCENE_ORIGINS = ["added", "split"] as const;
export type TimelineAddedSceneOrigin = (typeof TIMELINE_ADDED_SCENE_ORIGINS)[number];

/** Every user-created scene id starts with this, so they never collide with script ids (`s01`, ...). */
export const TIMELINE_ADDED_SCENE_ID_PREFIX = "usr-";
export const TIMELINE_ADDED_SCENE_ID_MAX_LENGTH = 100;
export const TIMELINE_ADDED_SCENE_NARRATION_MAX_LENGTH = 4000;
export const TIMELINE_ADDED_SCENE_SCREEN_TEXT_MAX_LENGTH = 2000;
export const TIMELINE_ADDED_SCENE_DURATION_MIN_MS = 500;
export const TIMELINE_ADDED_SCENE_DURATION_MAX_MS = 120_000;
export const TIMELINE_ADDED_SCENE_DEFAULT_DURATION_MS = 4000;
export const TIMELINE_MAX_SCENES = 60;

export type TimelineEditScene = TimelineSceneRangeLike & {
  audioVersionId?: string | null;
  subtitleVersionId?: string | null;
  screenTextOverride?: string | null;
  annotation?: string | null;
  excluded?: boolean;
  /** VE2E-93: the scene's caption style override (only the fields that differ from the whole-video style). */
  captionStyleOverride?: CaptionTextStylePatch | null;
};

export type TimelineAddedSceneDef = {
  sceneId: string;
  narration: string;
  screenText: string;
  durationHintMs: number;
  origin: TimelineAddedSceneOrigin;
  splitFromSceneId?: string | null;
};

export type TimelineEditState<S extends TimelineEditScene = TimelineEditScene, G extends TimelineSegmentLike = TimelineSegmentLike> = {
  scenes: S[];
  segments: G[];
  addedScenes: TimelineAddedSceneDef[];
  removedSceneIds: string[];
};

export type TimelineEditResult<T> = ({ ok: true } & T) | { ok: false; message: string };

/** Text facts about the scene being duplicated/split - the domain does not know script narration, the caller (context) does. */
export type TimelineSceneTextInfo = { narration: string; screenText: string; durationHintMs: number };

const clampDuration = (value: number): number =>
  Math.min(TIMELINE_ADDED_SCENE_DURATION_MAX_MS, Math.max(TIMELINE_ADDED_SCENE_DURATION_MIN_MS, Math.round(Number.isFinite(value) ? value : TIMELINE_ADDED_SCENE_DEFAULT_DURATION_MS)));

/** Next free `usr-N` id (max existing N + 1) - deterministic for a given state, never reuses an id still referenced. */
export function nextAddedSceneId(state: Pick<TimelineEditState, "scenes" | "addedScenes" | "removedSceneIds">): string {
  let max = 0;
  const all = [...state.scenes.map((s) => s.sceneId), ...state.addedScenes.map((s) => s.sceneId), ...state.removedSceneIds, ...state.addedScenes.map((s) => s.splitFromSceneId ?? "")];
  for (const id of all) {
    if (!id.startsWith(TIMELINE_ADDED_SCENE_ID_PREFIX)) continue;
    const n = Number(id.slice(TIMELINE_ADDED_SCENE_ID_PREFIX.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${TIMELINE_ADDED_SCENE_ID_PREFIX}${max + 1}`;
}

/** Sentence boundaries of a narration; same definition as caption segmentation, plus CJK `。！？` (which carry no trailing space). */
export function splitNarrationIntoSentences(narration: string): string[] {
  return splitIntoSentences(narration)
    .flatMap((piece) => piece.split(/(?<=[。！？])/))
    .map((piece) => piece.trim())
    .filter(Boolean);
}

const insertionIndex = (scenes: readonly TimelineEditScene[], afterSceneId: string | null | undefined): number | null => {
  if (afterSceneId === null || afterSceneId === undefined) return scenes.length;
  const index = scenes.findIndex((scene) => scene.sceneId === afterSceneId);
  return index === -1 ? null : index + 1;
};

/** Re-establishes segment invariants after an edit (a segment broken by an insert in its middle is dropped, scenes keep their media). */
const finalize = <S extends TimelineEditScene, G extends TimelineSegmentLike>(state: TimelineEditState<S, G>): TimelineEditState<S, G> => {
  const normalized = normalizeTimelineSegments(state.scenes, state.segments);
  return { ...state, scenes: normalized.scenes, segments: normalized.segments };
};

const blankBinding = (sceneId: string): TimelineEditScene => ({
  sceneId,
  mediaAssetVersionId: null,
  audioVersionId: null,
  subtitleVersionId: null,
  screenTextOverride: null,
  annotation: null,
  excluded: false,
  segmentId: null,
  sourceStartMs: null,
  sourceDurationMs: null,
  captionStyleOverride: null,
});

/**
 * Inserts a new scene (no media, no voice) after `afterSceneId` (`null`/omitted = at the end).
 * Fails on empty/oversized narration, unknown anchor, or the scene cap. An insert in the middle of
 * a background segment splits that segment's contiguity, so the segment is dropped (its scenes keep
 * their media/range) - the same repair `normalizeTimelineSegments` applies to a reorder.
 */
export function insertScene<S extends TimelineEditScene, G extends TimelineSegmentLike>(
  state: TimelineEditState<S, G>,
  input: { afterSceneId?: string | null; narration: string; screenText?: string; durationHintMs?: number },
): TimelineEditResult<{ state: TimelineEditState<S, G>; sceneId: string }> {
  const narration = input.narration?.trim() ?? "";
  if (!narration) return { ok: false, message: "Lời đọc của cảnh mới không được để trống" };
  if (narration.length > TIMELINE_ADDED_SCENE_NARRATION_MAX_LENGTH) return { ok: false, message: "Lời đọc của cảnh mới quá dài" };
  const screenText = input.screenText?.trim() ?? "";
  if (screenText.length > TIMELINE_ADDED_SCENE_SCREEN_TEXT_MAX_LENGTH) return { ok: false, message: "Text trên màn hình quá dài" };
  if (state.scenes.length >= TIMELINE_MAX_SCENES) return { ok: false, message: `Timeline đã đạt tối đa ${TIMELINE_MAX_SCENES} cảnh` };
  const at = insertionIndex(state.scenes, input.afterSceneId);
  if (at === null) return { ok: false, message: `Không tìm thấy cảnh ${String(input.afterSceneId)}` };
  const sceneId = nextAddedSceneId(state);
  const def: TimelineAddedSceneDef = { sceneId, narration, screenText, durationHintMs: clampDuration(input.durationHintMs ?? TIMELINE_ADDED_SCENE_DEFAULT_DURATION_MS), origin: "added", splitFromSceneId: null };
  const scenes = [...state.scenes.slice(0, at), blankBinding(sceneId) as S, ...state.scenes.slice(at)];
  return { ok: true, sceneId, state: finalize({ ...state, scenes, addedScenes: [...state.addedScenes, def] }) };
}

/**
 * Duplicates a scene right after itself: same text (caller supplies it), same media and source
 * range (so the user can then pick a different cut), but no voice and no segment membership.
 */
export function duplicateScene<S extends TimelineEditScene, G extends TimelineSegmentLike>(
  state: TimelineEditState<S, G>,
  sceneId: string,
  source: TimelineSceneTextInfo,
): TimelineEditResult<{ state: TimelineEditState<S, G>; sceneId: string }> {
  const original = state.scenes.find((scene) => scene.sceneId === sceneId);
  if (!original) return { ok: false, message: `Không tìm thấy cảnh ${sceneId}` };
  const inserted = insertScene(state, { afterSceneId: sceneId, narration: source.narration, screenText: source.screenText, durationHintMs: source.durationHintMs });
  if (!inserted.ok) return inserted;
  const scenes = inserted.state.scenes.map((scene) =>
    scene.sceneId === inserted.sceneId
      ? ({
          ...scene,
          mediaAssetVersionId: original.mediaAssetVersionId ?? null,
          screenTextOverride: original.screenTextOverride ?? null,
          sourceStartMs: original.sourceStartMs ?? null,
          sourceDurationMs: original.sourceDurationMs ?? null,
          // VE2E-93: the copy looks the same as the original.
          captionStyleOverride: original.captionStyleOverride ?? null,
        } as S)
      : scene,
  );
  return { ok: true, sceneId: inserted.sceneId, state: finalize({ ...inserted.state, scenes }) };
}

/**
 * Drops a scene from the timeline. An added/split scene is deleted outright (definition too); a
 * script scene is recorded in `removedSceneIds` so it can be restored - the script is never edited.
 * Segment membership is repaired (an emptied segment disappears).
 */
export function removeScene<S extends TimelineEditScene, G extends TimelineSegmentLike>(
  state: TimelineEditState<S, G>,
  sceneId: string,
): TimelineEditResult<{ state: TimelineEditState<S, G> }> {
  if (!state.scenes.some((scene) => scene.sceneId === sceneId)) return { ok: false, message: `Không tìm thấy cảnh ${sceneId}` };
  const isAdded = state.addedScenes.some((def) => def.sceneId === sceneId);
  const scenes = state.scenes.filter((scene) => scene.sceneId !== sceneId);
  const segments = state.segments
    .map((segment) => ({ ...segment, sceneIds: segment.sceneIds.filter((id) => id !== sceneId) }))
    .filter((segment) => segment.sceneIds.length > 0);
  return {
    ok: true,
    state: finalize({
      scenes,
      segments,
      addedScenes: isAdded ? state.addedScenes.filter((def) => def.sceneId !== sceneId) : state.addedScenes,
      removedSceneIds: isAdded || state.removedSceneIds.includes(sceneId) ? state.removedSceneIds : [...state.removedSceneIds, sceneId],
    }),
  };
}

/** Brings a removed script scene back as a blank binding (media/voice must be re-assigned) at `afterSceneId` (omitted = end). */
export function restoreScene<S extends TimelineEditScene, G extends TimelineSegmentLike>(
  state: TimelineEditState<S, G>,
  sceneId: string,
  afterSceneId?: string | null,
): TimelineEditResult<{ state: TimelineEditState<S, G> }> {
  if (!state.removedSceneIds.includes(sceneId)) return { ok: false, message: `Cảnh ${sceneId} không nằm trong danh sách đã xóa` };
  if (state.scenes.length >= TIMELINE_MAX_SCENES) return { ok: false, message: `Timeline đã đạt tối đa ${TIMELINE_MAX_SCENES} cảnh` };
  const at = insertionIndex(state.scenes, afterSceneId);
  if (at === null) return { ok: false, message: `Không tìm thấy cảnh ${String(afterSceneId)}` };
  const scenes = [...state.scenes.slice(0, at), blankBinding(sceneId) as S, ...state.scenes.slice(at)];
  return { ok: true, state: finalize({ ...state, scenes, removedSceneIds: state.removedSceneIds.filter((id) => id !== sceneId) }) };
}

/** Edits an added/split scene's own text. Changing narration clears its voice/subtitle (they were for the old text). */
export function updateAddedScene<S extends TimelineEditScene, G extends TimelineSegmentLike>(
  state: TimelineEditState<S, G>,
  sceneId: string,
  patch: { narration?: string; screenText?: string; durationHintMs?: number },
): TimelineEditResult<{ state: TimelineEditState<S, G> }> {
  const def = state.addedScenes.find((d) => d.sceneId === sceneId);
  if (!def) return { ok: false, message: `Cảnh ${sceneId} không phải cảnh tự thêm` };
  const narration = patch.narration === undefined ? def.narration : patch.narration.trim();
  if (!narration) return { ok: false, message: "Lời đọc của cảnh không được để trống" };
  if (narration.length > TIMELINE_ADDED_SCENE_NARRATION_MAX_LENGTH) return { ok: false, message: "Lời đọc của cảnh quá dài" };
  const screenText = patch.screenText === undefined ? def.screenText : patch.screenText.trim();
  if (screenText.length > TIMELINE_ADDED_SCENE_SCREEN_TEXT_MAX_LENGTH) return { ok: false, message: "Text trên màn hình quá dài" };
  const narrationChanged = narration !== def.narration;
  const next: TimelineAddedSceneDef = { ...def, narration, screenText, durationHintMs: patch.durationHintMs === undefined ? def.durationHintMs : clampDuration(patch.durationHintMs) };
  return {
    ok: true,
    state: {
      ...state,
      addedScenes: state.addedScenes.map((d) => (d.sceneId === sceneId ? next : d)),
      scenes: narrationChanged ? state.scenes.map((scene) => (scene.sceneId === sceneId ? ({ ...scene, audioVersionId: null, subtitleVersionId: null } as S) : scene)) : state.scenes,
    },
  };
}

export type SplitSceneInput = {
  sceneId: string;
  /** Narration/screenText/duration of the scene being split (script scene: from the script; added scene: from its definition). */
  source: TimelineSceneTextInfo;
  /** Number of leading sentences that stay in the first half (1 .. sentenceCount-1); see `splitNarrationIntoSentences`. */
  sentenceBoundary: number;
  /** Kind + duration of the bound media, so a video with no range yet can be given contiguous ranges. */
  mediaKind?: "video" | "image" | null;
  mediaDurationMs?: number | null;
};

/**
 * Splits one scene into two at a sentence boundary of its narration. Both halves get NEW ids, so the
 * original (script) scene is recoverable and an added original is replaced. Duration is divided by
 * narration length. Both halves keep the same media; when a source range applies, the second range
 * starts exactly where the first ends (`second.start = first.start + first.duration`). A video with
 * no range yet is given `[0, d1]` / `[d1, d2]` from the scene duration (clamped to the media length).
 * Neither half carries audio. Segment membership is replaced in place by the two halves, which are
 * consecutive, so the segment stays valid.
 */
export function splitScene<S extends TimelineEditScene, G extends TimelineSegmentLike>(
  state: TimelineEditState<S, G>,
  input: SplitSceneInput,
): TimelineEditResult<{ state: TimelineEditState<S, G>; firstSceneId: string; secondSceneId: string }> {
  const index = state.scenes.findIndex((scene) => scene.sceneId === input.sceneId);
  if (index === -1) return { ok: false, message: `Không tìm thấy cảnh ${input.sceneId}` };
  if (state.scenes.length + 1 > TIMELINE_MAX_SCENES) return { ok: false, message: `Timeline đã đạt tối đa ${TIMELINE_MAX_SCENES} cảnh` };
  const original = state.scenes[index]!;
  const sentences = splitNarrationIntoSentences(input.source.narration);
  if (sentences.length < 2) return { ok: false, message: "Cảnh cần ít nhất 2 câu để cắt tại ranh giới câu" };
  const boundary = input.sentenceBoundary;
  if (!Number.isInteger(boundary) || boundary < 1 || boundary > sentences.length - 1) return { ok: false, message: "Vị trí cắt không nằm giữa hai câu" };
  const firstNarration = sentences.slice(0, boundary).join(" ");
  const secondNarration = sentences.slice(boundary).join(" ");
  const ratio = firstNarration.length / (firstNarration.length + secondNarration.length);

  const total = clampDuration(input.source.durationHintMs);
  const firstDuration = Math.min(Math.max(1, Math.round(total * ratio)), total - 1);
  const secondDuration = total - firstDuration;

  let firstRange: { start: number; duration: number } | null = null;
  let secondRange: { start: number; duration: number } | null = null;
  const hasRange = original.sourceStartMs != null && original.sourceDurationMs != null;
  if (original.mediaAssetVersionId && hasRange) {
    const start = original.sourceStartMs!;
    const dur = original.sourceDurationMs!;
    if (dur < 2) return { ok: false, message: "Dải cắt của cảnh quá ngắn để chia đôi" };
    const d1 = Math.min(Math.max(1, Math.round(dur * ratio)), dur - 1);
    firstRange = { start, duration: d1 };
    secondRange = { start: start + d1, duration: dur - d1 };
  } else if (original.mediaAssetVersionId && input.mediaKind === "video") {
    const basis = input.mediaDurationMs != null && input.mediaDurationMs > 0 ? Math.min(total, input.mediaDurationMs) : total;
    if (basis >= 2) {
      const d1 = Math.min(Math.max(1, Math.round(basis * ratio)), basis - 1);
      firstRange = { start: 0, duration: d1 };
      secondRange = { start: d1, duration: basis - d1 };
    }
  }
  if (secondRange && secondRange.start + secondRange.duration > TIMELINE_SOURCE_RANGE_MAX_MS) return { ok: false, message: "Dải cắt vượt giới hạn" };

  const firstId = nextAddedSceneId(state);
  const secondId = nextAddedSceneId({ ...state, addedScenes: [...state.addedScenes, { sceneId: firstId, narration: "", screenText: "", durationHintMs: 0, origin: "split" }] });
  const originalDef = state.addedScenes.find((def) => def.sceneId === input.sceneId);
  // Root script scene this pair descends from; an added original has none (it is deleted, not recoverable).
  const splitFrom = originalDef ? originalDef.splitFromSceneId ?? null : input.sceneId;

  const half = (sceneId: string, range: typeof firstRange, isFirst: boolean): S =>
    ({
      ...blankBinding(sceneId),
      mediaAssetVersionId: original.mediaAssetVersionId ?? null,
      excluded: Boolean(original.excluded),
      screenTextOverride: isFirst ? original.screenTextOverride ?? null : null,
      annotation: isFirst ? original.annotation ?? null : null,
      segmentId: original.segmentId ?? null,
      sourceStartMs: range ? range.start : null,
      sourceDurationMs: range ? range.duration : null,
      // VE2E-93: both halves keep the original scene's caption style.
      captionStyleOverride: original.captionStyleOverride ?? null,
    }) as S;

  const scenes = [...state.scenes.slice(0, index), half(firstId, firstRange, true), half(secondId, secondRange, false), ...state.scenes.slice(index + 1)];
  const segments = state.segments.map((segment) =>
    segment.sceneIds.includes(input.sceneId) ? { ...segment, sceneIds: segment.sceneIds.flatMap((id) => (id === input.sceneId ? [firstId, secondId] : [id])) } : segment,
  );
  const defs: TimelineAddedSceneDef[] = [
    { sceneId: firstId, narration: firstNarration, screenText: input.source.screenText.trim(), durationHintMs: firstDuration, origin: "split", splitFromSceneId: splitFrom },
    { sceneId: secondId, narration: secondNarration, screenText: "", durationHintMs: secondDuration, origin: "split", splitFromSceneId: splitFrom },
  ];
  return {
    ok: true,
    firstSceneId: firstId,
    secondSceneId: secondId,
    state: finalize({
      scenes,
      segments,
      addedScenes: [...state.addedScenes.filter((def) => def.sceneId !== input.sceneId), ...defs],
      removedSceneIds: originalDef || state.removedSceneIds.includes(input.sceneId) ? state.removedSceneIds : [...state.removedSceneIds, input.sceneId],
    }),
  };
}

export type TimelineEditValidationContext = {
  /** Scene ids of the approved script the timeline is pinned to. */
  scriptSceneIds: ReadonlySet<string> | readonly string[];
};

/**
 * Structural validation of a whole edit state (what the API runs on save/approve). Rejects:
 * duplicate / unknown / colliding ids, an added scene missing from the timeline, empty or oversized
 * narration, bad origin/duration, a removed id that is not a script scene (or still on the timeline,
 * or listed twice), a `splitFromSceneId` that points nowhere, and a broken segment structure.
 * When the timeline has no edits (`addedScenes`/`removedSceneIds` empty) scene ids are NOT checked
 * against the script, so every pre-VE2E-58 timeline validates exactly as before.
 */
export function validateTimelineEditState(
  state: Pick<TimelineEditState, "scenes" | "segments" | "addedScenes" | "removedSceneIds">,
  context: TimelineEditValidationContext,
): { ok: true } | { ok: false; message: string } {
  const scriptIds = new Set(context.scriptSceneIds);
  const timelineIds = new Set<string>();
  for (const scene of state.scenes) {
    if (timelineIds.has(scene.sceneId)) return { ok: false, message: `sceneId trùng lặp trong timeline: ${scene.sceneId}` };
    timelineIds.add(scene.sceneId);
  }
  if (!Array.isArray(state.addedScenes) || !Array.isArray(state.removedSceneIds)) return { ok: false, message: "addedScenes/removedSceneIds phải là mảng" };

  const addedIds = new Set<string>();
  for (const def of state.addedScenes) {
    const id = typeof def?.sceneId === "string" ? def.sceneId : "";
    if (!id.trim() || id.length > TIMELINE_ADDED_SCENE_ID_MAX_LENGTH) return { ok: false, message: "sceneId của cảnh tự thêm không hợp lệ" };
    if (addedIds.has(id)) return { ok: false, message: `Cảnh tự thêm trùng lặp: ${id}` };
    if (scriptIds.has(id)) return { ok: false, message: `sceneId cảnh tự thêm trùng với cảnh trong kịch bản: ${id}` };
    addedIds.add(id);
    if (!(TIMELINE_ADDED_SCENE_ORIGINS as readonly string[]).includes(def.origin)) return { ok: false, message: `Cảnh ${id}: origin không hợp lệ` };
    if (typeof def.narration !== "string" || !def.narration.trim()) return { ok: false, message: `Cảnh ${id}: lời đọc không được để trống` };
    if (def.narration.length > TIMELINE_ADDED_SCENE_NARRATION_MAX_LENGTH) return { ok: false, message: `Cảnh ${id}: lời đọc quá dài` };
    if (typeof def.screenText !== "string" || def.screenText.length > TIMELINE_ADDED_SCENE_SCREEN_TEXT_MAX_LENGTH) return { ok: false, message: `Cảnh ${id}: text trên màn hình không hợp lệ` };
    if (!Number.isInteger(def.durationHintMs) || def.durationHintMs < TIMELINE_ADDED_SCENE_DURATION_MIN_MS || def.durationHintMs > TIMELINE_ADDED_SCENE_DURATION_MAX_MS) {
      return { ok: false, message: `Cảnh ${id}: durationHintMs không hợp lệ` };
    }
    if (!timelineIds.has(id)) return { ok: false, message: `Cảnh tự thêm ${id} không có trong timeline` };
  }
  for (const def of state.addedScenes) {
    const from = def.splitFromSceneId;
    if (from === undefined || from === null) continue;
    if (def.origin !== "split") return { ok: false, message: `Cảnh ${def.sceneId}: splitFromSceneId chỉ dùng cho cảnh origin=split` };
    if (!scriptIds.has(from) && !addedIds.has(from)) return { ok: false, message: `Cảnh ${def.sceneId}: splitFromSceneId không tồn tại: ${from}` };
  }

  const removed = new Set<string>();
  for (const id of state.removedSceneIds) {
    if (typeof id !== "string" || !id.trim()) return { ok: false, message: "removedSceneIds chứa id không hợp lệ" };
    if (removed.has(id)) return { ok: false, message: `removedSceneIds trùng lặp: ${id}` };
    removed.add(id);
    if (!scriptIds.has(id)) return { ok: false, message: `removedSceneIds chứa cảnh không thuộc kịch bản: ${id}` };
    if (timelineIds.has(id)) return { ok: false, message: `Cảnh ${id} vừa bị xóa vừa còn trong timeline` };
  }

  if (state.addedScenes.length > 0 || state.removedSceneIds.length > 0) {
    for (const id of timelineIds) {
      if (!scriptIds.has(id) && !addedIds.has(id)) return { ok: false, message: `Timeline có cảnh không xác định (không thuộc kịch bản và không phải cảnh tự thêm): ${id}` };
    }
  }
  return validateTimelineSegmentStructure(state.scenes, state.segments);
}
