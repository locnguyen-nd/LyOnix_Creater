import { describe, expect, it } from "vitest";
import { validateTimelineSegmentStructure } from "./timeline-segments.js";
import {
  duplicateScene,
  insertScene,
  nextAddedSceneId,
  removeScene,
  restoreScene,
  splitNarrationIntoSentences,
  splitScene,
  updateAddedScene,
  validateTimelineEditState,
  type TimelineEditScene,
  type TimelineEditState,
} from "./timeline-edit.js";

const scene = (sceneId: string, extra: Partial<TimelineEditScene> = {}): TimelineEditScene => ({ sceneId, mediaAssetVersionId: `m-${sceneId}`, audioVersionId: `a-${sceneId}`, ...extra });
const base = (scenes: TimelineEditScene[], segments: TimelineEditState["segments"] = []): TimelineEditState => ({ scenes, segments, addedScenes: [], removedSceneIds: [] });
const ok = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
};
const ids = (state: TimelineEditState) => state.scenes.map((s) => s.sceneId);
const scriptIds = ["s1", "s2", "s3"];

describe("splitNarrationIntoSentences", () => {
  it("splits latin and CJK sentence terminals", () => {
    expect(splitNarrationIntoSentences("Hello there. How are you? Fine!")).toEqual(["Hello there.", "How are you?", "Fine!"]);
    expect(splitNarrationIntoSentences("今日は晴れです。明日は雨です。")).toEqual(["今日は晴れです。", "明日は雨です。"]);
    expect(splitNarrationIntoSentences("no terminal")).toEqual(["no terminal"]);
  });
});

describe("insertScene", () => {
  it("inserts a blank scene (no media/voice) after the anchor and records its definition", () => {
    const result = ok(insertScene(base([scene("s1"), scene("s2")]), { afterSceneId: "s1", narration: "  Xin chào  ", screenText: "Hi" }));
    expect(ids(result.state)).toEqual(["s1", "usr-1", "s2"]);
    const added = result.state.scenes[1]!;
    expect(added).toMatchObject({ mediaAssetVersionId: null, audioVersionId: null, subtitleVersionId: null, excluded: false });
    expect(result.state.addedScenes).toEqual([{ sceneId: "usr-1", narration: "Xin chào", screenText: "Hi", durationHintMs: 4000, origin: "added", splitFromSceneId: null }]);
  });

  it("appends at the end when no anchor and gives ids deterministically (max+1, never reused while referenced)", () => {
    const first = ok(insertScene(base([scene("s1")]), { narration: "a" }));
    const second = ok(insertScene(first.state, { narration: "b" }));
    expect(ids(second.state)).toEqual(["s1", "usr-1", "usr-2"]);
    const removed = ok(removeScene(second.state, "usr-2")).state;
    expect(nextAddedSceneId(removed)).toBe("usr-2");
    expect(nextAddedSceneId(second.state)).toBe("usr-3");
  });

  it("rejects empty narration, unknown anchor and the scene cap", () => {
    expect(insertScene(base([scene("s1")]), { narration: "   " }).ok).toBe(false);
    expect(insertScene(base([scene("s1")]), { afterSceneId: "nope", narration: "x" }).ok).toBe(false);
    const many = base(Array.from({ length: 60 }, (_, i) => scene(`s${i}`)));
    expect(insertScene(many, { narration: "x" }).ok).toBe(false);
  });

  it("drops a segment broken by an insert in its middle but keeps scene media/range, and the result validates", () => {
    const state = base(
      [scene("s1", { segmentId: "g", sourceStartMs: 0, sourceDurationMs: 1000 }), scene("s2", { segmentId: "g", sourceStartMs: 1000, sourceDurationMs: 1000 })],
      [{ segmentId: "g", sceneIds: ["s1", "s2"] }],
    );
    const result = ok(insertScene(state, { afterSceneId: "s1", narration: "mid" })).state;
    expect(result.segments).toEqual([]);
    expect(result.scenes[0]).toMatchObject({ segmentId: null, mediaAssetVersionId: "m-s1", sourceStartMs: 0 });
    expect(validateTimelineSegmentStructure(result.scenes, result.segments)).toEqual({ ok: true });
  });
});

describe("duplicateScene", () => {
  it("copies text + media + range but never audio or segment membership", () => {
    const state = base([scene("s1", { segmentId: "g", sourceStartMs: 500, sourceDurationMs: 2000 }), scene("s2", { segmentId: "g", sourceStartMs: 2500, sourceDurationMs: 1000 })], [{ segmentId: "g", sceneIds: ["s1", "s2"] }]);
    const result = ok(duplicateScene(state, "s2", { narration: "N2.", screenText: "T2", durationHintMs: 3000 }));
    expect(ids(result.state)).toEqual(["s1", "s2", "usr-1"]);
    expect(result.state.scenes[2]).toMatchObject({ mediaAssetVersionId: "m-s2", audioVersionId: null, segmentId: null, sourceStartMs: 2500, sourceDurationMs: 1000 });
    expect(result.state.addedScenes[0]).toMatchObject({ narration: "N2.", origin: "added" });
    expect(result.state.segments).toEqual([{ segmentId: "g", sceneIds: ["s1", "s2"] }]);
  });
});

describe("removeScene / restoreScene", () => {
  it("removes a script scene recoverably (never deletes script data) and restores it blank", () => {
    const removed = ok(removeScene(base([scene("s1"), scene("s2"), scene("s3")]), "s2")).state;
    expect(ids(removed)).toEqual(["s1", "s3"]);
    expect(removed.removedSceneIds).toEqual(["s2"]);
    const restored = ok(restoreScene(removed, "s2", "s1")).state;
    expect(ids(restored)).toEqual(["s1", "s2", "s3"]);
    expect(restored.removedSceneIds).toEqual([]);
    expect(restored.scenes[1]).toMatchObject({ mediaAssetVersionId: null, audioVersionId: null });
  });

  it("deletes an added scene for good (no removed entry)", () => {
    const added = ok(insertScene(base([scene("s1")]), { narration: "x" })).state;
    const removed = ok(removeScene(added, "usr-1")).state;
    expect(ids(removed)).toEqual(["s1"]);
    expect(removed.addedScenes).toEqual([]);
    expect(removed.removedSceneIds).toEqual([]);
  });

  it("removes the scene from its segment and drops an emptied segment; remaining segment stays valid", () => {
    const state = base(
      [scene("s1", { segmentId: "g" }), scene("s2", { segmentId: "g" }), scene("s3", { segmentId: "h" })],
      [{ segmentId: "g", sceneIds: ["s1", "s2"] }, { segmentId: "h", sceneIds: ["s3"] }],
    );
    const afterOne = ok(removeScene(state, "s2")).state;
    expect(afterOne.segments).toEqual([{ segmentId: "g", sceneIds: ["s1"] }, { segmentId: "h", sceneIds: ["s3"] }]);
    const afterTwo = ok(removeScene(afterOne, "s1")).state;
    expect(afterTwo.segments).toEqual([{ segmentId: "h", sceneIds: ["s3"] }]);
    expect(validateTimelineSegmentStructure(afterTwo.scenes, afterTwo.segments)).toEqual({ ok: true });
  });

  it("is a no-op error for unknown / not-removed ids and idempotent on repeated removal attempts", () => {
    const state = base([scene("s1"), scene("s2")]);
    expect(removeScene(state, "zz").ok).toBe(false);
    expect(restoreScene(state, "s1").ok).toBe(false);
    const once = ok(removeScene(state, "s1")).state;
    expect(removeScene(once, "s1").ok).toBe(false);
    expect(once.removedSceneIds).toEqual(["s1"]);
  });
});

describe("splitScene", () => {
  const narration = "Câu một. Câu hai dài hơn nhiều. Câu ba.";

  it("splits at a sentence boundary into two NEW scenes with no audio, same media, original recoverable", () => {
    const state = base([scene("s1"), scene("s2"), scene("s3")]);
    const result = ok(splitScene(state, { sceneId: "s2", source: { narration, screenText: "Tiêu đề", durationHintMs: 9000 }, sentenceBoundary: 1 }));
    expect(ids(result.state)).toEqual(["s1", "usr-1", "usr-2", "s3"]);
    expect(result.firstSceneId).toBe("usr-1");
    expect(result.secondSceneId).toBe("usr-2");
    expect(result.state.removedSceneIds).toEqual(["s2"]);
    const [a, b] = [result.state.scenes[1]!, result.state.scenes[2]!];
    expect(a).toMatchObject({ mediaAssetVersionId: "m-s2", audioVersionId: null, subtitleVersionId: null });
    expect(b).toMatchObject({ mediaAssetVersionId: "m-s2", audioVersionId: null, subtitleVersionId: null });
    expect(result.state.addedScenes).toEqual([
      { sceneId: "usr-1", narration: "Câu một.", screenText: "Tiêu đề", durationHintMs: expect.any(Number), origin: "split", splitFromSceneId: "s2" },
      { sceneId: "usr-2", narration: "Câu hai dài hơn nhiều. Câu ba.", screenText: "", durationHintMs: expect.any(Number), origin: "split", splitFromSceneId: "s2" },
    ]);
    const [d1, d2] = result.state.addedScenes.map((d) => d.durationHintMs);
    expect(d1! + d2!).toBe(9000);
    expect(d1!).toBeLessThan(d2!);
  });

  it("keeps source ranges contiguous: second.start = first.start + first.duration, total preserved", () => {
    const state = base([scene("s1", { sourceStartMs: 4000, sourceDurationMs: 9000 })]);
    const result = ok(splitScene(state, { sceneId: "s1", source: { narration, screenText: "", durationHintMs: 9000 }, sentenceBoundary: 2 })).state;
    const [a, b] = result.scenes;
    expect(a!.sourceStartMs).toBe(4000);
    expect(b!.sourceStartMs).toBe(a!.sourceStartMs! + a!.sourceDurationMs!);
    expect(a!.sourceDurationMs! + b!.sourceDurationMs!).toBe(9000);
    expect(validateTimelineSegmentStructure(result.scenes, result.segments)).toEqual({ ok: true });
  });

  it("gives a video with no range contiguous [0,d1]/[d1,d2] clamped to media length, but no range for an image", () => {
    const video = ok(splitScene(base([scene("s1")]), { sceneId: "s1", source: { narration, screenText: "", durationHintMs: 10_000 }, sentenceBoundary: 1, mediaKind: "video", mediaDurationMs: 6000 })).state;
    expect(video.scenes[0]!.sourceStartMs).toBe(0);
    expect(video.scenes[1]!.sourceStartMs).toBe(video.scenes[0]!.sourceDurationMs);
    expect(video.scenes[0]!.sourceDurationMs! + video.scenes[1]!.sourceDurationMs!).toBe(6000);
    const image = ok(splitScene(base([scene("s1")]), { sceneId: "s1", source: { narration, screenText: "", durationHintMs: 10_000 }, sentenceBoundary: 1, mediaKind: "image" })).state;
    expect(image.scenes.map((s) => s.sourceStartMs)).toEqual([null, null]);
  });

  it("replaces the scene inside its segment with the two consecutive halves (segment stays valid)", () => {
    const state = base(
      [scene("s1", { segmentId: "g", sourceStartMs: 0, sourceDurationMs: 4000 }), scene("s2", { segmentId: "g", sourceStartMs: 4000, sourceDurationMs: 4000 }), scene("s3")],
      [{ segmentId: "g", sceneIds: ["s1", "s2"], subject: "Tokyo", priority: 1 }],
    );
    const result = ok(splitScene(state, { sceneId: "s1", source: { narration, screenText: "", durationHintMs: 4000 }, sentenceBoundary: 1 })).state;
    expect(result.segments).toEqual([{ segmentId: "g", sceneIds: ["usr-1", "usr-2", "s2"], subject: "Tokyo", priority: 1 }]);
    expect(result.scenes.slice(0, 3).map((s) => s.segmentId)).toEqual(["g", "g", "g"]);
    expect(validateTimelineSegmentStructure(result.scenes, result.segments)).toEqual({ ok: true });
  });

  it("splitting an added scene replaces it (no removed entry) and keeps the script root; re-splitting works", () => {
    const first = ok(splitScene(base([scene("s1")]), { sceneId: "s1", source: { narration, screenText: "", durationHintMs: 9000 }, sentenceBoundary: 1 })).state;
    const second = ok(splitScene(first, { sceneId: "usr-2", source: { narration: first.addedScenes[1]!.narration, screenText: "", durationHintMs: first.addedScenes[1]!.durationHintMs }, sentenceBoundary: 1 })).state;
    expect(ids(second)).toEqual(["usr-1", "usr-3", "usr-4"]);
    expect(second.removedSceneIds).toEqual(["s1"]);
    expect(second.addedScenes.map((d) => [d.sceneId, d.splitFromSceneId])).toEqual([["usr-1", "s1"], ["usr-3", "s1"], ["usr-4", "s1"]]);
    expect(validateTimelineEditState(second, { scriptSceneIds: scriptIds })).toEqual({ ok: true });
  });

  it("rejects a single sentence, a bad boundary and an unknown scene", () => {
    const state = base([scene("s1")]);
    expect(splitScene(state, { sceneId: "s1", source: { narration: "Một câu.", screenText: "", durationHintMs: 3000 }, sentenceBoundary: 1 }).ok).toBe(false);
    for (const sentenceBoundary of [0, 3, 1.5]) {
      expect(splitScene(state, { sceneId: "s1", source: { narration, screenText: "", durationHintMs: 3000 }, sentenceBoundary }).ok).toBe(false);
    }
    expect(splitScene(state, { sceneId: "zz", source: { narration, screenText: "", durationHintMs: 3000 }, sentenceBoundary: 1 }).ok).toBe(false);
  });
});

describe("updateAddedScene", () => {
  it("clears voice only when narration changes; rejects empty narration and non-added scenes", () => {
    const added = ok(insertScene(base([scene("s1")]), { narration: "old" })).state;
    const withVoice = { ...added, scenes: added.scenes.map((s) => (s.sceneId === "usr-1" ? { ...s, audioVersionId: "a1", subtitleVersionId: "sub1" } : s)) };
    const sameText = ok(updateAddedScene(withVoice, "usr-1", { screenText: "T" })).state;
    expect(sameText.scenes[1]).toMatchObject({ audioVersionId: "a1", subtitleVersionId: "sub1" });
    const changed = ok(updateAddedScene(withVoice, "usr-1", { narration: "new" })).state;
    expect(changed.scenes[1]).toMatchObject({ audioVersionId: null, subtitleVersionId: null });
    expect(updateAddedScene(withVoice, "usr-1", { narration: " " }).ok).toBe(false);
    expect(updateAddedScene(withVoice, "s1", { narration: "x" }).ok).toBe(false);
  });
});

describe("validateTimelineEditState", () => {
  const context = { scriptSceneIds: scriptIds };
  const def = (sceneId: string, extra: Record<string, unknown> = {}) => ({ sceneId, narration: "x", screenText: "", durationHintMs: 3000, origin: "added" as const, ...extra });

  it("accepts a legacy timeline (no edits) even with unknown scene ids", () => {
    expect(validateTimelineEditState(base([scene("whatever")]), context)).toEqual({ ok: true });
  });

  it("accepts a valid edited timeline", () => {
    const state = { ...base([scene("s1"), scene("usr-1")]), addedScenes: [def("usr-1")], removedSceneIds: ["s2"] };
    expect(validateTimelineEditState(state, context)).toEqual({ ok: true });
  });

  it("rejects duplicate ids, collisions with script ids, missing-from-timeline, empty narration, bad origin/duration", () => {
    const tl = [scene("s1"), scene("usr-1")];
    expect(validateTimelineEditState({ ...base(tl), addedScenes: [def("usr-1"), def("usr-1")] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base([scene("s1")]), addedScenes: [def("s1")] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base([scene("s1")]), addedScenes: [def("usr-9")] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base(tl), addedScenes: [def("usr-1", { narration: "  " })] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base(tl), addedScenes: [def("usr-1", { origin: "weird" })] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base(tl), addedScenes: [def("usr-1", { durationHintMs: 5 })] }, context).ok).toBe(false);
    expect(validateTimelineEditState(base([scene("s1"), scene("s1")]), context).ok).toBe(false);
  });

  it("rejects unknown timeline ids once edits exist, bad removed ids and a dangling splitFromSceneId", () => {
    expect(validateTimelineEditState({ ...base([scene("s1"), scene("ghost")]), removedSceneIds: ["s2"] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base([scene("s1")]), removedSceneIds: ["nope"] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base([scene("s1")]), removedSceneIds: ["s1"] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base([scene("s1")]), removedSceneIds: ["s2", "s2"] }, context).ok).toBe(false);
    const tl = [scene("usr-1")];
    expect(validateTimelineEditState({ ...base(tl), addedScenes: [def("usr-1", { origin: "split", splitFromSceneId: "gone" })] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base(tl), addedScenes: [def("usr-1", { origin: "added", splitFromSceneId: "s1" })] }, context).ok).toBe(false);
    expect(validateTimelineEditState({ ...base(tl), addedScenes: [def("usr-1", { origin: "split", splitFromSceneId: "s1" })] }, context)).toEqual({ ok: true });
  });

  it("also enforces the shared segment structure", () => {
    const state = { ...base([scene("s1", { segmentId: "g" })], []), addedScenes: [] };
    expect(validateTimelineEditState(state, context).ok).toBe(false);
  });
});
