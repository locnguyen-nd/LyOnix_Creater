import { describe, expect, it } from "vitest";
import type { PlannedSegment } from "@lyonix/domain";
import type { SegmentSource, SourcedSegment } from "./media-plan.service.js";
import { ensureUniqueSegmentIds, orderByScript, reconcileSourcedSegments, sameSegmentStructure } from "./workflow-media-resume.js";

const seg = (segmentId: string, sceneIds: string[], extra: Partial<PlannedSegment> = {}): PlannedSegment => ({ segmentId, sceneIds, subject: null, priority: null, keywords: null, durationMs: 0, origin: "fallback", ...extra });
const src = (id: string, durationMs: number | null, extra: Partial<SegmentSource> = {}): SegmentSource => ({ mediaAssetVersionId: id, kind: "video", durationMs, externalId: id, sourcing: "imported", provider: "pexels", ...extra });
const sourced = (segment: PlannedSegment, source: SegmentSource | null): SourcedSegment => ({ segment, source, errorCode: source ? null : "X" });
const durations = (map: Record<string, number>) => (sceneId: string) => map[sceneId] ?? 1;

describe("reconcileSourcedSegments (VE2E-133)", () => {
  it("same grouping and coverage: every early source is kept, nothing is searched again", () => {
    const early = [sourced(seg("s1", ["a", "b"]), src("A", 20_000)), sourced(seg("s2", ["c"]), src("C", 20_000))];
    const result = reconcileSourcedSegments({ finalSegments: [seg("s1", ["a", "b"]), seg("s2", ["c"])], early, durationOf: durations({ a: 4000, b: 5000, c: 6000 }) });
    expect(result.toSource).toEqual([]);
    expect(result.reused.map((piece) => [piece.segment.segmentId, piece.source?.mediaAssetVersionId])).toEqual([["s1", "A"], ["s2", "C"]]);
    expect(result.stats).toMatchObject({ exact: 2, overlap: 0, resourced: 0, unused: 0 });
  });

  it("voice longer than the hint: the clip keeps its covered scenes, only the uncovered tail is searched, and keywords carry over", () => {
    const early = [sourced(seg("s1", ["a", "b", "c"], { keywords: { ja: "猫", en: "cat" } }), src("A", 10_000))];
    const result = reconcileSourcedSegments({ finalSegments: [seg("s1", ["a", "b", "c"])], early, durationOf: durations({ a: 4000, b: 4000, c: 6000 }) });
    expect(result.reused.map((piece) => [piece.segment.segmentId, piece.segment.sceneIds])).toEqual([["s1", ["a", "b"]]]);
    expect(result.toSource.map((segment) => [segment.segmentId, segment.sceneIds, segment.durationMs, segment.keywords?.en])).toEqual([["s1-b", ["c"], 6000, "cat"]]);
  });

  it("an early second-source piece (tail) is reused for the tail instead of searching again", () => {
    const early = [sourced(seg("s1", ["a", "b"]), src("A", 10_000)), sourced(seg("s1-b", ["c"]), src("C", 20_000))];
    const result = reconcileSourcedSegments({ finalSegments: [seg("s1", ["a", "b", "c"])], early, durationOf: durations({ a: 4000, b: 4000, c: 6000 }) });
    expect(result.toSource).toEqual([]);
    expect(result.reused.map((piece) => [piece.segment.sceneIds, piece.source?.mediaAssetVersionId])).toEqual([[["a", "b"], "A"], [["c"], "C"]]);
  });

  it("regrouped plan (voice durations moved the boundary): a source is taken over by the segment of its first scene, the rest is searched", () => {
    const early = [sourced(seg("s1", ["a", "b"]), src("A", 30_000)), sourced(seg("s2", ["c", "d"]), src("C", 30_000))];
    const final = [seg("s1", ["a"]), seg("s2", ["b", "c"]), seg("s3", ["d"])];
    const result = reconcileSourcedSegments({ finalSegments: final, early, durationOf: durations({ a: 3000, b: 3000, c: 3000, d: 3000 }) });
    expect(sameSegmentStructure(early.map((piece) => piece.segment), final)).toBe(false);
    expect(result.reused.map((piece) => [piece.segment.segmentId, piece.source?.mediaAssetVersionId])).toEqual([["s1", "A"], ["s3", "C"]]);
    // s2 (b, c) starts in the early s1 whose clip A is already taken by final s1 -> only s2 is searched; s3 (d) takes the clip of the early segment that held d.
    expect(result.toSource.map((segment) => segment.segmentId)).toEqual(["s2"]);
    expect(result.stats.exact).toBe(0);
  });

  it("a source is never assigned to two final segments", () => {
    const early = [sourced(seg("s1", ["a", "b", "c", "d"]), src("A", 60_000))];
    const result = reconcileSourcedSegments({ finalSegments: [seg("x", ["a", "b"]), seg("y", ["c", "d"])], early, durationOf: durations({ a: 3000, b: 3000, c: 3000, d: 3000 }) });
    expect(result.reused.map((piece) => piece.segment.segmentId)).toEqual(["x"]);
    expect(result.toSource.map((segment) => segment.segmentId)).toEqual(["y"]);
  });

  it("degraded (window / placeholder) and sourceless early pieces are only reused on an exact scene match", () => {
    const window = src("W", 20_000, { degraded: "reused_window" as never, window: { startMs: 0, durationMs: 8000 } });
    const early = [sourced(seg("s1", ["a", "b"]), window), sourced(seg("s2", ["c"]), null)];
    const result = reconcileSourcedSegments({ finalSegments: [seg("s1", ["a"]), seg("s2", ["c"])], early, durationOf: durations({ a: 3000, b: 3000, c: 3000 }) });
    expect(result.reused).toEqual([]);
    expect(result.toSource.map((segment) => segment.segmentId)).toEqual(["s1", "s2"]);
    const exact = reconcileSourcedSegments({ finalSegments: [seg("s1", ["a", "b"])], early: [early[0]!], durationOf: durations({ a: 3000, b: 3000 }) });
    expect(exact.reused.map((piece) => piece.source?.mediaAssetVersionId)).toEqual(["W"]);
  });

  it("an image source or an unknown clip duration is kept as-is (nothing to cover)", () => {
    const early = [sourced(seg("s1", ["a", "b"]), src("I", null, { kind: "image" })), sourced(seg("s2", ["c"]), src("V", null))];
    const result = reconcileSourcedSegments({ finalSegments: [seg("s1", ["a", "b"]), seg("s2", ["c"])], early, durationOf: durations({ a: 9000, b: 9000, c: 9000 }) });
    expect(result.toSource).toEqual([]);
    expect(result.reused).toHaveLength(2);
  });

  it("tail ids never collide with an existing segment id", () => {
    const early = [sourced(seg("s1", ["a", "b"]), src("A", 4000))];
    const result = reconcileSourcedSegments({ finalSegments: [seg("s1", ["a", "b"]), seg("s1-b", ["c"])], early, durationOf: durations({ a: 3000, b: 3000, c: 3000 }) });
    expect(result.toSource.map((segment) => segment.segmentId).sort()).toEqual(["s1-b", "s1-b2"]);
  });

  it("orderByScript sorts pieces by the position of their first scene", () => {
    const pieces = [sourced(seg("t", ["c"]), null), sourced(seg("h", ["a", "b"]), null)];
    expect(orderByScript(pieces, ["a", "b", "c"]).map((piece) => piece.segment.segmentId)).toEqual(["h", "t"]);
  });
});

describe("ensureUniqueSegmentIds", () => {
  it("renames a repeated segment id so the timeline never sees a duplicate", () => {
    const pieces = [sourced(seg("segment2-b", ["a"]), src("A", 9000)), sourced(seg("segment2-b", ["b"]), src("B", 9000)), sourced(seg("x", ["c"]), src("C", 9000))];
    const ids = ensureUniqueSegmentIds(pieces).map((piece) => piece.segment.segmentId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("segment2-b");
    expect(ensureUniqueSegmentIds(pieces)[1]!.segment.sceneIds).toEqual(["b"]);
  });
});
