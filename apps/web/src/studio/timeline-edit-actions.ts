/**
 * VE2E-59 (CR-STUDIO-EDIT-PARALLEL-2026-10-01 §3A): pure Studio-side wrappers over the VE2E-58 domain
 * ops (`@lyonix/domain/timeline-edit`). No React, no I/O: StudioProPage calls these inside its existing
 * `mutate()` (undo-stack + autosave), so every edit is undoable and goes through the same save path.
 *
 * Voice rule (VE2E-58 handoff): a scene created by add/duplicate/split has no `SceneDraftVersion` row
 * until the timeline is SAVED (the server mirrors it then), so `StudioSceneContextResponse.id` is "" for
 * such a scene until the first save + context refresh. Voice generation must flush the save first.
 */
import {
  duplicateScene,
  insertScene,
  removeScene,
  restoreScene,
  splitNarrationIntoSentences,
  splitScene,
  type TimelineAddedSceneDef,
  type TimelineEditState,
} from "@lyonix/domain/timeline-edit";
import type { StudioSceneContextResponse, TimelineAddedSceneInput, TimelineSegmentResponse } from "@lyonix/contracts";

export type EditableScene = {
  sceneId: string;
  mediaAssetVersionId: string | null;
  mediaLabel: string | null;
  audioVersionId: string | null;
  subtitleVersionId: string | null;
  screenTextOverride: string | null;
  annotation: string | null;
  excluded: boolean;
  segmentId: string | null;
  sourceStartMs: number | null;
  sourceDurationMs: number | null;
};

export type EditableDraft<S extends EditableScene = EditableScene> = {
  scenes: S[];
  segments: TimelineSegmentResponse[];
  addedScenes: TimelineAddedSceneDef[];
  removedSceneIds: string[];
};

export type EditOutcome<D> = { ok: true; draft: D; selectSceneId: string | null } | { ok: false; message: string };

export const NO_SCENE_ID = "";

const toState = <D extends EditableDraft>(draft: D): TimelineEditState<D["scenes"][number], TimelineSegmentResponse> => ({
  scenes: draft.scenes,
  segments: draft.segments,
  addedScenes: draft.addedScenes,
  removedSceneIds: draft.removedSceneIds,
});

/** Domain blank bindings carry no `mediaLabel`; keep the draft's field non-undefined. */
const fromState = <D extends EditableDraft>(draft: D, state: TimelineEditState<D["scenes"][number], TimelineSegmentResponse>): D => ({
  ...draft,
  scenes: state.scenes.map((scene) => ({ ...scene, mediaLabel: scene.mediaLabel ?? null })),
  segments: state.segments,
  addedScenes: state.addedScenes,
  removedSceneIds: state.removedSceneIds,
});

export type SceneTextInfo = { narration: string; screenText: string; durationHintMs: number };

/** Text of a scene: an added/split scene's own definition, else the script scene from the Studio context. */
export function sceneTextInfo(sceneId: string, draft: Pick<EditableDraft, "addedScenes">, contextScenes: readonly StudioSceneContextResponse[]): SceneTextInfo | null {
  const def = draft.addedScenes.find((row) => row.sceneId === sceneId);
  if (def) return { narration: def.narration, screenText: def.screenText, durationHintMs: def.durationHintMs };
  const scene = contextScenes.find((row) => row.sceneId === sceneId);
  return scene ? { narration: scene.narration, screenText: scene.screenText, durationHintMs: scene.durationHintMs } : null;
}

/**
 * The scenes Studio works with, in timeline order: the context row (script scene, or a mirrored added
 * scene once saved) with an added/split scene's draft definition winning for text/duration. An added
 * scene not yet saved has no context row: it gets a placeholder with `id === ""` (see `sceneNeedsSave`).
 * Script scenes dropped from the timeline are not in this list (see `removedSceneInfos`).
 */
export function buildEffectiveScenes(contextScenes: readonly StudioSceneContextResponse[], draft: Pick<EditableDraft, "scenes" | "addedScenes">): StudioSceneContextResponse[] {
  const contextById = new Map(contextScenes.map((scene) => [scene.sceneId, scene]));
  const defById = new Map(draft.addedScenes.map((def) => [def.sceneId, def]));
  const out: StudioSceneContextResponse[] = [];
  draft.scenes.forEach((row, index) => {
    const def = defById.get(row.sceneId);
    const base = contextById.get(row.sceneId);
    if (def) {
      out.push({
        id: base?.id ?? NO_SCENE_ID,
        sceneId: row.sceneId,
        orderIndex: index,
        narration: def.narration,
        screenText: def.screenText,
        visualQuery: base?.visualQuery ?? "",
        durationHintMs: def.durationHintMs,
        origin: def.origin,
        splitFromSceneId: def.splitFromSceneId ?? null,
      });
    } else if (base) {
      out.push(base);
    }
  });
  return out;
}

/** True while an added/split scene has no persisted `SceneDraftVersion` yet, i.e. the timeline must be saved before voice can be generated for it. */
export const sceneNeedsSave = (scene: Pick<StudioSceneContextResponse, "id"> | null | undefined): boolean => !!scene && !scene.id;

/** After a save, the server has mirrored new scenes: true when the cached context still lacks the id of one of them. */
export function contextNeedsRefresh(contextScenes: readonly StudioSceneContextResponse[], addedScenes: readonly { sceneId: string }[]): boolean {
  const known = new Set(contextScenes.filter((scene) => scene.id).map((scene) => scene.sceneId));
  return addedScenes.some((def) => !known.has(def.sceneId));
}

/** Non-excluded scenes without voice - the only ones "Sinh giọng cho cảnh thiếu" may generate (never a scene that already has audio). */
export function missingVoiceSceneIds(draft: Pick<EditableDraft, "scenes">): string[] {
  return draft.scenes.filter((row) => !row.excluded && !row.audioVersionId).map((row) => row.sceneId);
}

/** Script scenes dropped from the timeline, in script order, with their text for the "cảnh đã xóa" list. */
export function removedSceneInfos(contextScenes: readonly StudioSceneContextResponse[], draft: Pick<EditableDraft, "removedSceneIds">): StudioSceneContextResponse[] {
  const removed = new Set(draft.removedSceneIds);
  return contextScenes.filter((scene) => removed.has(scene.sceneId));
}

/** Request fields for the VE2E-58 contract (`addedScenes` / `removedSceneIds`). */
export function buildEditSavePayload(draft: Pick<EditableDraft, "addedScenes" | "removedSceneIds">): { addedScenes: TimelineAddedSceneInput[]; removedSceneIds: string[] } {
  return {
    addedScenes: draft.addedScenes.map((def) => ({
      sceneId: def.sceneId,
      narration: def.narration,
      screenText: def.screenText,
      durationHintMs: def.durationHintMs,
      origin: def.origin,
      splitFromSceneId: def.splitFromSceneId ?? null,
    })),
    removedSceneIds: [...draft.removedSceneIds],
  };
}

/** Scene order for the first load: saved order, then unsaved script scenes, never a scene the user removed (it lives in `removedSceneIds`). */
export function resolveOrderedSceneIds(
  contextSceneIds: readonly string[],
  savedSceneIds: readonly string[],
  removedSceneIds: readonly string[],
): string[] {
  const known = new Set(contextSceneIds);
  const removed = new Set(removedSceneIds);
  const saved = new Set(savedSceneIds);
  return [
    ...savedSceneIds.filter((id) => known.has(id) && !removed.has(id)),
    ...contextSceneIds.filter((id) => !saved.has(id) && !removed.has(id)),
  ];
}

export function addBlankScene<D extends EditableDraft>(draft: D, input: { afterSceneId: string | null; narration: string; screenText?: string; durationHintMs?: number }): EditOutcome<D> {
  const result = insertScene(toState(draft), input);
  return result.ok ? { ok: true, draft: fromState(draft, result.state), selectSceneId: result.sceneId } : result;
}

export function duplicateSelectedScene<D extends EditableDraft>(draft: D, sceneId: string, contextScenes: readonly StudioSceneContextResponse[]): EditOutcome<D> {
  const info = sceneTextInfo(sceneId, draft, contextScenes);
  if (!info) return { ok: false, message: `Không tìm thấy cảnh ${sceneId}` };
  const result = duplicateScene(toState(draft), sceneId, info);
  return result.ok ? { ok: true, draft: fromState(draft, result.state), selectSceneId: result.sceneId } : result;
}

/** Removes a scene from the timeline; a timeline must keep at least one scene. `selectSceneId` = the neighbour to select next. */
export function removeSelectedScene<D extends EditableDraft>(draft: D, sceneId: string): EditOutcome<D> {
  const index = draft.scenes.findIndex((row) => row.sceneId === sceneId);
  if (index === -1) return { ok: false, message: `Không tìm thấy cảnh ${sceneId}` };
  if (draft.scenes.length <= 1) return { ok: false, message: "Timeline cần giữ ít nhất 1 cảnh" };
  const result = removeScene(toState(draft), sceneId);
  if (!result.ok) return result;
  const next = draft.scenes[index + 1] ?? draft.scenes[index - 1];
  return { ok: true, draft: fromState(draft, result.state), selectSceneId: next?.sceneId ?? null };
}

export function restoreRemovedScene<D extends EditableDraft>(draft: D, sceneId: string, afterSceneId: string | null): EditOutcome<D> {
  const result = restoreScene(toState(draft), sceneId, afterSceneId);
  return result.ok ? { ok: true, draft: fromState(draft, result.state), selectSceneId: sceneId } : result;
}

export type SplitPlan = { sentences: string[]; /** Valid boundaries: 1..sentences.length-1 = number of sentences kept in the first half. */ boundaries: number[] };

export function planSplit(narration: string): SplitPlan {
  const sentences = splitNarrationIntoSentences(narration);
  return { sentences, boundaries: sentences.length < 2 ? [] : Array.from({ length: sentences.length - 1 }, (_, i) => i + 1) };
}

export function splitSelectedScene<D extends EditableDraft>(
  draft: D,
  sceneId: string,
  sentenceBoundary: number,
  contextScenes: readonly StudioSceneContextResponse[],
  media: { kind?: "video" | "image" | null; durationMs?: number | null } = {},
): EditOutcome<D> {
  const info = sceneTextInfo(sceneId, draft, contextScenes);
  if (!info) return { ok: false, message: `Không tìm thấy cảnh ${sceneId}` };
  const result = splitScene(toState(draft), { sceneId, source: info, sentenceBoundary, mediaKind: media.kind ?? null, mediaDurationMs: media.durationMs ?? null });
  return result.ok ? { ok: true, draft: fromState(draft, result.state), selectSceneId: result.firstSceneId } : result;
}
