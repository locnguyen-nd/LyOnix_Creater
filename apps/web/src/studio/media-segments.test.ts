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
