import { describe, expect, it } from "vitest";
import type { MediaPlanResponse } from "@lyonix/contracts";
import type { TimelineSceneDraftForSave } from "./timeline-save";
import { applyMediaPlan, replaceSegmentSource } from "./media-segments";

const scene = (sceneId: string, overrides: Partial<TimelineSceneDraftForSave> = {}): TimelineSceneDraftForSave => ({
  sceneId, mediaAssetVersionId: null, audioVersionId: `audio-${sceneId}`, subtitleVersionId: `sub-${sceneId}`,
  screenTextOverride: `caption-${sceneId}`, annotation: null, excluded: false, segmentId: null,
  sourceStartMs: null, sourceDurationMs: null, ...overrides,
});

const plan: MediaPlanResponse = {
  policyVersion: "media-plan.v1", range: { min: 2, max: 3 },
  scenes: [
    { sceneId: "s1", mediaAssetVersionId: "src", segmentId: "g1", sourceStartMs: 0, sourceDurationMs: 3000 },
    { sceneId: "s2", mediaAssetVersionId: "src", segmentId: "g1", sourceStartMs: 3000, sourceDurationMs: 2000 },
  ],
  segments: [{ segmentId: "g1", sceneIds: ["s1", "s2"], mediaAssetVersionId: "src", subject: "city", priority: 1 }],
  diagnostics: [],
};

describe("Studio media segment edits", () => {
  it("applies the shared plan while preserving per-scene audio and caption bindings", () => {
    const result = applyMediaPlan([scene("s1"), scene("s2")], plan);
    expect(result.scenes.map((row) => [row.mediaAssetVersionId, row.segmentId, row.sourceStartMs, row.audioVersionId, row.screenTextOverride])).toEqual([
      ["src", "g1", 0, "audio-s1", "caption-s1"], ["src", "g1", 3000, "audio-s2", "caption-s2"],
    ]);
    expect(result.segments[0]?.sceneIds).toEqual(["s1", "s2"]);
  });

  it("replaces every scene in the segment and recomputes contiguous ranges from the in-point", () => {
    const current = applyMediaPlan([scene("s1"), scene("s2")], plan);
    const result = replaceSegmentSource(current.scenes, current.segments, "g1", { id: "replacement", kind: "video", durationMs: 9000 }, 1000);
    expect(result.scenes.map((row) => [row.mediaAssetVersionId, row.sourceStartMs, row.sourceDurationMs])).toEqual([
      ["replacement", 1000, 3000], ["replacement", 4000, 2000],
    ]);
    expect(result.segments[0]?.mediaAssetVersionId).toBe("replacement");
  });

  it("restarts at the beginning when a replacement source ends between scenes", () => {
    const current = applyMediaPlan([scene("s1"), scene("s2")], plan);
    const result = replaceSegmentSource(current.scenes, current.segments, "g1", { id: "short", kind: "video", durationMs: 4000 }, 3000);
    expect(result.scenes.map((row) => [row.sourceStartMs, row.sourceDurationMs])).toEqual([[3000, 1000], [0, 2000]]);
  });

  it("clears clip ranges for every scene when the segment is replaced with a photo", () => {
    const current = applyMediaPlan([scene("s1"), scene("s2")], plan);
    const result = replaceSegmentSource(current.scenes, current.segments, "g1", { id: "photo", kind: "image", durationMs: null });
    expect(result.scenes.map((row) => [row.mediaAssetVersionId, row.sourceStartMs, row.sourceDurationMs])).toEqual([
      ["photo", null, null], ["photo", null, null],
    ]);
  });
});

import { assignSceneOnly, detachSceneFromSegment, inPointShortfall } from "./media-segments";
import { validateTimelineSegmentStructure } from "@lyonix/domain/timeline-segments";

describe("per-scene override inside a segment", () => {
  const four = () => ({
    scenes: ["a", "b", "c", "d"].map((id, i) => scene(id, { mediaAssetVersionId: "src", segmentId: "g1", sourceStartMs: i * 1000, sourceDurationMs: 1000 })),
    segments: [{ segmentId: "g1", sceneIds: ["a", "b", "c", "d"], mediaAssetVersionId: "src", subject: null, priority: null }],
  });
  const valid = (r: { scenes: TimelineSceneDraftForSave[]; segments: { segmentId: string; sceneIds: string[] }[] }) => validateTimelineSegmentStructure(r.scenes, r.segments);

  it("detaching a middle scene splits the segment and keeps both halves valid", () => {
    const { scenes, segments } = four();
    const r = detachSceneFromSegment(scenes, segments, "b");
    expect(r.segments.map((s) => s.sceneIds)).toEqual([["a"], ["c", "d"]]);
    expect(r.segments[1]!.segmentId).not.toBe("g1");
    const b = r.scenes.find((s) => s.sceneId === "b")!;
    expect([b.segmentId, b.sourceStartMs, b.sourceDurationMs]).toEqual([null, null, null]);
    expect(r.scenes.find((s) => s.sceneId === "c")!.sourceStartMs).toBe(2000);
    expect(valid(r)).toEqual({ ok: true });
  });

  it("detaching the first/last scene shrinks the segment; a lone scene removes it", () => {
    const { scenes, segments } = four();
    expect(detachSceneFromSegment(scenes, segments, "a").segments.map((s) => [s.segmentId, s.sceneIds])).toEqual([["g1", ["b", "c", "d"]]]);
    expect(detachSceneFromSegment(scenes, segments, "d").segments.map((s) => s.sceneIds)).toEqual([["a", "b", "c"]]);
    const one = detachSceneFromSegment([scenes[0]!], [{ ...segments[0]!, sceneIds: ["a"] }], "a");
    expect(one.segments).toEqual([]);
    expect(valid(one)).toEqual({ ok: true });
  });

  it("assignSceneOnly changes only that scene and leaves the rest of the segment on its source", () => {
    const { scenes, segments } = four();
    const r = assignSceneOnly(scenes, segments, "b", { id: "other", label: "L" });
    expect(r.scenes.map((s) => [s.mediaAssetVersionId, s.segmentId])).toEqual([["src", "g1"], ["other", null], ["src", expect.any(String)], ["src", expect.any(String)]]);
    expect(valid(r)).toEqual({ ok: true });
  });

  it("is a no-op for a scene outside any segment", () => {
    const r = detachSceneFromSegment([scene("x")], [], "x");
    expect(r.segments).toEqual([]);
  });

  it("reports a shortfall only when the in-point leaves too little footage", () => {
    const { scenes, segments } = four(); // needs 4000ms
    expect(inPointShortfall(scenes, segments[0]!, 10000, 0)).toBeNull();
    expect(inPointShortfall(scenes, segments[0]!, 10000, 6000)).toBeNull();
    expect(inPointShortfall(scenes, segments[0]!, 10000, 8000)).toEqual({ shortByMs: 2000 });
    expect(inPointShortfall(scenes, segments[0]!, null, 8000)).toBeNull();
  });
});
