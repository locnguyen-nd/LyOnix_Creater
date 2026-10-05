import { describe, expect, it } from "vitest";
import { normalizeTimelineSegments, validateTimelineSegmentStructure } from "./timeline-segments.js";

const scenes = (count: number, extra: (index: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: count }, (_, index) => ({ sceneId: `s${index + 1}`, mediaAssetVersionId: `m${index + 1}`, ...extra(index) }));

describe("validateTimelineSegmentStructure", () => {
  it("accepts a legacy timeline with no segments and no ranges", () => {
    expect(validateTimelineSegmentStructure(scenes(3), undefined)).toEqual({ ok: true });
    expect(validateTimelineSegmentStructure(scenes(3), [])).toEqual({ ok: true });
    expect(validateTimelineSegmentStructure([{ sceneId: "a" }], null)).toEqual({ ok: true });
  });

  it("accepts consecutive segments with consistent scene segmentIds and ranges", () => {
    const list = scenes(4, (i) => ({ segmentId: i < 2 ? "g1" : "g2", sourceStartMs: i * 1000, sourceDurationMs: 1000 }));
    expect(
      validateTimelineSegmentStructure(list, [
        { segmentId: "g1", sceneIds: ["s1", "s2"], mediaAssetVersionId: "m1", subject: "Tokyo", priority: 1 },
        { segmentId: "g2", sceneIds: ["s3", "s4"], priority: 2 },
      ]),
    ).toEqual({ ok: true });
  });

  it("rejects a half-set, negative, zero or non-integer range, and a range without media", () => {
    expect(validateTimelineSegmentStructure([{ sceneId: "a", mediaAssetVersionId: "m", sourceStartMs: 0 }], []).ok).toBe(false);
    expect(validateTimelineSegmentStructure([{ sceneId: "a", mediaAssetVersionId: "m", sourceStartMs: -1, sourceDurationMs: 100 }], []).ok).toBe(false);
    expect(validateTimelineSegmentStructure([{ sceneId: "a", mediaAssetVersionId: "m", sourceStartMs: 0, sourceDurationMs: 0 }], []).ok).toBe(false);
    expect(validateTimelineSegmentStructure([{ sceneId: "a", mediaAssetVersionId: "m", sourceStartMs: 0.5, sourceDurationMs: 100 }], []).ok).toBe(false);
    expect(validateTimelineSegmentStructure([{ sceneId: "a", sourceStartMs: 0, sourceDurationMs: 100 }], []).ok).toBe(false);
  });

  it("rejects non-consecutive, out-of-order, unknown, shared or empty segment scenes", () => {
    const list = scenes(3, () => ({ segmentId: "g1" }));
    expect(validateTimelineSegmentStructure(list, [{ segmentId: "g1", sceneIds: ["s1", "s3"] }]).ok).toBe(false);
    expect(validateTimelineSegmentStructure(scenes(2, () => ({ segmentId: "g1" })), [{ segmentId: "g1", sceneIds: ["s2", "s1"] }]).ok).toBe(false);
    expect(validateTimelineSegmentStructure(scenes(1, () => ({ segmentId: "g1" })), [{ segmentId: "g1", sceneIds: ["s1", "zz"] }]).ok).toBe(false);
    expect(validateTimelineSegmentStructure(scenes(1, () => ({ segmentId: "g1" })), [{ segmentId: "g1", sceneIds: ["s1"] }, { segmentId: "g2", sceneIds: ["s1"] }]).ok).toBe(false);
    expect(validateTimelineSegmentStructure(scenes(1), [{ segmentId: "g1", sceneIds: [] }]).ok).toBe(false);
  });

  it("rejects duplicate segment ids, bad priority and inconsistent scene.segmentId", () => {
    expect(validateTimelineSegmentStructure(scenes(2, (i) => ({ segmentId: "g1" + i })), [{ segmentId: "g", sceneIds: ["s1"] }, { segmentId: "g", sceneIds: ["s2"] }]).ok).toBe(false);
    expect(validateTimelineSegmentStructure(scenes(1, () => ({ segmentId: "g1" })), [{ segmentId: "g1", sceneIds: ["s1"], priority: 0 }]).ok).toBe(false);
    expect(validateTimelineSegmentStructure(scenes(1, () => ({ segmentId: "g1" })), [{ segmentId: "g1", sceneIds: ["s1"], priority: 1.5 }]).ok).toBe(false);
    // scene lists a segment that does not include it
    expect(validateTimelineSegmentStructure(scenes(1, () => ({ segmentId: "g9" })), []).ok).toBe(false);
    // segment lists a scene that does not carry the segmentId
    expect(validateTimelineSegmentStructure(scenes(1), [{ segmentId: "g1", sceneIds: ["s1"] }]).ok).toBe(false);
  });
});

describe("normalizeTimelineSegments", () => {
  it("is the identity (modulo explicit nulls) for a legacy timeline", () => {
    const result = normalizeTimelineSegments(scenes(2), undefined);
    expect(result.segments).toEqual([]);
    expect(result.scenes).toEqual([
      { sceneId: "s1", mediaAssetVersionId: "m1", segmentId: null, sourceStartMs: null, sourceDurationMs: null },
      { sceneId: "s2", mediaAssetVersionId: "m2", segmentId: null, sourceStartMs: null, sourceDurationMs: null },
    ]);
  });

  it("keeps a valid segment plan untouched", () => {
    const list = scenes(2, (i) => ({ segmentId: "g1", sourceStartMs: i * 1000, sourceDurationMs: 1000 }));
    const segments = [{ segmentId: "g1", sceneIds: ["s1", "s2"] }];
    const result = normalizeTimelineSegments(list, segments);
    expect(result.segments).toEqual(segments);
    expect(result.scenes).toEqual(list);
    expect(validateTimelineSegmentStructure(result.scenes, result.segments)).toEqual({ ok: true });
  });

  it("drops a segment broken by a reorder and clears its scenes' segmentId (ranges kept)", () => {
    const list = [
      { sceneId: "s1", mediaAssetVersionId: "m", segmentId: "g1", sourceStartMs: 0, sourceDurationMs: 1000 },
      { sceneId: "s3", mediaAssetVersionId: "m3", segmentId: null },
      { sceneId: "s2", mediaAssetVersionId: "m", segmentId: "g1", sourceStartMs: 1000, sourceDurationMs: 1000 },
    ];
    const result = normalizeTimelineSegments(list, [{ segmentId: "g1", sceneIds: ["s1", "s2"] }]);
    expect(result.segments).toEqual([]);
    expect(result.scenes.map((s) => s.segmentId)).toEqual([null, null, null]);
    expect(result.scenes[0]).toMatchObject({ sourceStartMs: 0, sourceDurationMs: 1000 });
    expect(validateTimelineSegmentStructure(result.scenes, result.segments)).toEqual({ ok: true });
  });

  it("drops a segment whose member lost its segmentId and clears a range left without media", () => {
    const list = [
      { sceneId: "s1", mediaAssetVersionId: "m", segmentId: "g1" },
      { sceneId: "s2", mediaAssetVersionId: null, segmentId: null, sourceStartMs: 0, sourceDurationMs: 500 },
    ];
    const result = normalizeTimelineSegments(list, [{ segmentId: "g1", sceneIds: ["s1", "s2"] }]);
    expect(result.segments).toEqual([]);
    expect(result.scenes[1]).toMatchObject({ segmentId: null, sourceStartMs: null, sourceDurationMs: null });
    expect(validateTimelineSegmentStructure(result.scenes, result.segments)).toEqual({ ok: true });
  });
});
