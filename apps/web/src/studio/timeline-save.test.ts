import { describe, expect, it } from "vitest";
import { buildTimelineSaveScenes, withMediaAssigned, type TimelineSceneDraftForSave } from "./timeline-save";

const scene = (sceneId: string, overrides: Partial<TimelineSceneDraftForSave> = {}): TimelineSceneDraftForSave => ({
  sceneId,
  mediaAssetVersionId: `m-${sceneId}`,
  audioVersionId: null,
  subtitleVersionId: null,
  screenTextOverride: null,
  annotation: null,
  excluded: false,
  segmentId: null,
  sourceStartMs: null,
  sourceDurationMs: null,
  ...overrides,
});

describe("buildTimelineSaveScenes (VE2E-42)", () => {
  it("sends a legacy timeline unchanged, with explicit null range fields and no segments", () => {
    const result = buildTimelineSaveScenes([scene("s1"), scene("s2")], []);
    expect(result.segments).toEqual([]);
    expect(result.scenes).toEqual([
      { sceneId: "s1", mediaAssetVersionId: "m-s1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false, segmentId: null, sourceStartMs: null, sourceDurationMs: null },
      { sceneId: "s2", mediaAssetVersionId: "m-s2", audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null, excluded: false, segmentId: null, sourceStartMs: null, sourceDurationMs: null },
    ]);
  });

  it("carries a persisted segment plan and ranges through a re-save", () => {
    const segments = [{ segmentId: "g1", sceneIds: ["s1", "s2"], mediaAssetVersionId: "src", subject: "Shibuya", priority: 1 }];
    const result = buildTimelineSaveScenes(
      [scene("s1", { mediaAssetVersionId: "src", segmentId: "g1", sourceStartMs: 0, sourceDurationMs: 3000 }), scene("s2", { mediaAssetVersionId: "src", segmentId: "g1", sourceStartMs: 3000, sourceDurationMs: 2000 })],
      segments,
    );
    expect(result.segments).toEqual(segments);
    expect(result.scenes.map((s) => [s.segmentId, s.sourceStartMs, s.sourceDurationMs])).toEqual([["g1", 0, 3000], ["g1", 3000, 2000]]);
  });

  it("drops a segment a reorder split apart instead of sending an invalid timeline", () => {
    const result = buildTimelineSaveScenes(
      [scene("s1", { segmentId: "g1" }), scene("s3"), scene("s2", { segmentId: "g1" })],
      [{ segmentId: "g1", sceneIds: ["s1", "s2"], mediaAssetVersionId: null, subject: null, priority: null }],
    );
    expect(result.segments).toEqual([]);
    expect(result.scenes.map((s) => s.segmentId)).toEqual([null, null, null]);
  });
});

describe("withMediaAssigned", () => {
  it("clears the range when the media changes and keeps it when re-picking the same asset", () => {
    const ranged = scene("s1", { mediaAssetVersionId: "src", segmentId: "g1", sourceStartMs: 1000, sourceDurationMs: 2000 });
    expect(withMediaAssigned(ranged, "src")).toBe(ranged);
    expect(withMediaAssigned(ranged, "other")).toMatchObject({ mediaAssetVersionId: "other", segmentId: "g1", sourceStartMs: null, sourceDurationMs: null });
  });
});
