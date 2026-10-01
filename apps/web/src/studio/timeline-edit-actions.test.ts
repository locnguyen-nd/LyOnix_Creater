import { describe, expect, it } from "vitest";
import type { StudioSceneContextResponse } from "@lyonix/contracts";
import { UndoStack } from "./undo-stack";
import {
  addBlankScene,
  buildEditSavePayload,
  buildEffectiveScenes,
  contextNeedsRefresh,
  duplicateSelectedScene,
  missingVoiceSceneIds,
  planSplit,
  removeSelectedScene,
  removedSceneInfos,
  resolveOrderedSceneIds,
  restoreRemovedScene,
  sceneNeedsSave,
  splitSelectedScene,
  type EditableDraft,
  type EditableScene,
} from "./timeline-edit-actions";

const scene = (sceneId: string, over: Partial<EditableScene> = {}): EditableScene => ({
  sceneId,
  mediaAssetVersionId: null,
  mediaLabel: null,
  audioVersionId: null,
  subtitleVersionId: null,
  screenTextOverride: null,
  annotation: null,
  excluded: false,
  segmentId: null,
  sourceStartMs: null,
  sourceDurationMs: null,
  ...over,
});

const ctxScene = (sceneId: string, narration: string, over: Partial<StudioSceneContextResponse> = {}): StudioSceneContextResponse => ({
  id: `row-${sceneId}`,
  sceneId,
  orderIndex: 0,
  narration,
  screenText: narration,
  visualQuery: "",
  durationHintMs: 6000,
  ...over,
});

const contextScenes = [
  ctxScene("s1", "Câu một. Câu hai. Câu ba."),
  ctxScene("s2", "Cảnh hai chỉ một câu"),
  ctxScene("s3", "Cảnh ba."),
];

const baseDraft = (): EditableDraft => ({
  scenes: [scene("s1", { audioVersionId: "a1" }), scene("s2", { audioVersionId: "a2" }), scene("s3", { audioVersionId: "a3" })],
  segments: [],
  addedScenes: [],
  removedSceneIds: [],
});

describe("VE2E-59 timeline edit actions", () => {
  it("adds a blank scene after the selected one with its narration, no voice yet", () => {
    const result = addBlankScene(baseDraft(), { afterSceneId: "s1", narration: "Cảnh mới hoàn toàn." });
    if (!result.ok) throw new Error(result.message);
    expect(result.draft.scenes.map((row) => row.sceneId)).toEqual(["s1", result.selectSceneId, "s2", "s3"]);
    const added = result.draft.scenes[1]!;
    expect(added.audioVersionId).toBeNull();
    expect(result.draft.addedScenes).toHaveLength(1);
    expect(result.draft.addedScenes[0]).toMatchObject({ narration: "Cảnh mới hoàn toàn.", origin: "added" });
  });

  it("rejects a blank narration", () => {
    expect(addBlankScene(baseDraft(), { afterSceneId: "s1", narration: "   " }).ok).toBe(false);
  });

  it("duplicates a scene with its text but without borrowing its voice", () => {
    const result = duplicateSelectedScene(baseDraft(), "s2", contextScenes);
    if (!result.ok) throw new Error(result.message);
    expect(result.draft.scenes).toHaveLength(4);
    const copy = result.draft.scenes[2]!;
    expect(copy.audioVersionId).toBeNull();
    expect(result.draft.addedScenes[0]!.narration).toBe("Cảnh hai chỉ một câu");
  });

  it("removes a script scene into the recoverable list and restores it", () => {
    const removed = removeSelectedScene(baseDraft(), "s2");
    if (!removed.ok) throw new Error(removed.message);
    expect(removed.draft.scenes.map((row) => row.sceneId)).toEqual(["s1", "s3"]);
    expect(removed.draft.removedSceneIds).toEqual(["s2"]);
    expect(removed.selectSceneId).toBe("s3");
    expect(removedSceneInfos(contextScenes, removed.draft).map((row) => row.sceneId)).toEqual(["s2"]);

    const restored = restoreRemovedScene(removed.draft, "s2", "s1");
    if (!restored.ok) throw new Error(restored.message);
    expect(restored.draft.scenes.map((row) => row.sceneId)).toEqual(["s1", "s2", "s3"]);
    expect(restored.draft.removedSceneIds).toEqual([]);
  });

  it("deletes an added scene for good (not recoverable)", () => {
    const added = addBlankScene(baseDraft(), { afterSceneId: "s3", narration: "Tạm." });
    if (!added.ok) throw new Error(added.message);
    const removed = removeSelectedScene(added.draft, added.selectSceneId!);
    if (!removed.ok) throw new Error(removed.message);
    expect(removed.draft.addedScenes).toEqual([]);
    expect(removed.draft.removedSceneIds).toEqual([]);
  });

  it("refuses to delete the last remaining scene", () => {
    const one: EditableDraft = { ...baseDraft(), scenes: [scene("s1")] };
    expect(removeSelectedScene(one, "s1").ok).toBe(false);
  });

  it("offers one split boundary per gap between sentences and none for a single sentence", () => {
    expect(planSplit("Câu một. Câu hai. Câu ba.").boundaries).toEqual([1, 2]);
    expect(planSplit("Chỉ một câu").boundaries).toEqual([]);
  });

  it("splits at a sentence boundary: both halves share the media with contiguous ranges and no audio", () => {
    const draft: EditableDraft = {
      ...baseDraft(),
      scenes: [scene("s1", { mediaAssetVersionId: "m1", sourceStartMs: 1000, sourceDurationMs: 6000, audioVersionId: "a1" }), scene("s2"), scene("s3")],
    };
    const result = splitSelectedScene(draft, "s1", 1, contextScenes, { kind: "video", durationMs: 60_000 });
    if (!result.ok) throw new Error(result.message);
    const [first, second] = result.draft.scenes;
    expect(result.draft.scenes).toHaveLength(4);
    expect(first!.mediaAssetVersionId).toBe("m1");
    expect(second!.mediaAssetVersionId).toBe("m1");
    expect(first!.audioVersionId).toBeNull();
    expect(second!.audioVersionId).toBeNull();
    expect(second!.sourceStartMs).toBe(first!.sourceStartMs! + first!.sourceDurationMs!);
    expect(result.draft.removedSceneIds).toEqual(["s1"]);
    expect(result.draft.addedScenes.map((def) => def.origin)).toEqual(["split", "split"]);
    expect(result.selectSceneId).toBe(first!.sceneId);
  });

  it("is undoable through the Studio undo stack", () => {
    const stack = new UndoStack<EditableDraft>();
    const before = baseDraft();
    const result = addBlankScene(before, { afterSceneId: "s1", narration: "Mới." });
    if (!result.ok) throw new Error(result.message);
    stack.push(before);
    expect(stack.undo(result.draft)).toEqual(before);
  });

  it("builds effective scenes: an unsaved added scene gets a placeholder that needs a save", () => {
    const added = addBlankScene(baseDraft(), { afterSceneId: "s1", narration: "Mới." });
    if (!added.ok) throw new Error(added.message);
    const effective = buildEffectiveScenes(contextScenes, added.draft);
    expect(effective.map((row) => row.sceneId)).toEqual(["s1", added.selectSceneId, "s2", "s3"]);
    const placeholder = effective[1]!;
    expect(sceneNeedsSave(placeholder)).toBe(true);
    expect(placeholder.narration).toBe("Mới.");
    expect(sceneNeedsSave(effective[0])).toBe(false);
    expect(contextNeedsRefresh(contextScenes, added.draft.addedScenes)).toBe(true);
    // After the server mirrored it the context carries its row id.
    const mirrored = [...contextScenes, ctxScene(added.selectSceneId!, "Mới.", { origin: "added" })];
    expect(contextNeedsRefresh(mirrored, added.draft.addedScenes)).toBe(false);
    expect(sceneNeedsSave(buildEffectiveScenes(mirrored, added.draft)[1])).toBe(false);
  });

  it("leaves a removed script scene out of the effective list", () => {
    const removed = removeSelectedScene(baseDraft(), "s2");
    if (!removed.ok) throw new Error(removed.message);
    expect(buildEffectiveScenes(contextScenes, removed.draft).map((row) => row.sceneId)).toEqual(["s1", "s3"]);
  });

  it("lists only scenes without voice for generation - never one that already has audio", () => {
    const draft: EditableDraft = { ...baseDraft(), scenes: [scene("s1", { audioVersionId: "a1" }), scene("n1"), scene("n2", { excluded: true })] };
    expect(missingVoiceSceneIds(draft)).toEqual(["n1"]);
  });

  it("serialises the save payload for the VE2E-58 contract", () => {
    const added = addBlankScene(baseDraft(), { afterSceneId: "s1", narration: "Mới." });
    if (!added.ok) throw new Error(added.message);
    const removed = removeSelectedScene(added.draft, "s3");
    if (!removed.ok) throw new Error(removed.message);
    const payload = buildEditSavePayload(removed.draft);
    expect(payload.removedSceneIds).toEqual(["s3"]);
    expect(payload.addedScenes[0]).toMatchObject({ narration: "Mới.", origin: "added", splitFromSceneId: null });
  });

  it("keeps saved order on reload, appends new script scenes, and never resurrects a removed scene", () => {
    expect(resolveOrderedSceneIds(["s1", "s2", "s3"], ["s3", "s1"], ["s2"])).toEqual(["s3", "s1"]);
    expect(resolveOrderedSceneIds(["s1", "s2", "s3", "s4"], ["s2", "s1"], [])).toEqual(["s2", "s1", "s3", "s4"]);
    expect(resolveOrderedSceneIds(["s1", "usr-1"], ["usr-1", "s1"], [])).toEqual(["usr-1", "s1"]);
  });
});
