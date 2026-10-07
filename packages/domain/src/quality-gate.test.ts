import { describe, expect, it } from "vitest";
import { estimateCaptionLines, qualityGateConfigFromEnv, runQualityGate, type QualityGateAsset, type QualityGateScene } from "./quality-gate.js";

const scene = (n: number, over: Partial<QualityGateScene> = {}): QualityGateScene => ({
  sceneId: `s${n}`, segmentId: `g${n}`, assetId: `a${n}`, kind: "video", sourceStartMs: 0, sourceDurationMs: 5_000, sceneDurationMs: 5_000, narration: "Xin chao", ...over,
});
const asset = (id: string, over: Partial<QualityGateAsset> = {}): QualityGateAsset => ({ id, kind: "video", durationMs: 30_000, widthPx: 1080, heightPx: 1920, ...over });

describe("quality gate", () => {
  it("passes a clean timeline", () => {
    const r = runQualityGate({ scenes: [scene(1), scene(2), scene(3), scene(4), scene(5), scene(6)], assets: [1, 2, 3, 4, 5, 6].map((n) => asset(`a${n}`)), targetSec: 30 });
    expect(r.failure).toBeNull();
    expect(r.fixes).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("is a no-op when disabled", () => {
    const scenes = [scene(1, { assetId: "x" }), scene(2, { assetId: "x" })];
    const r = runQualityGate({ scenes, assets: [asset("x")], targetSec: 10, config: { enabled: false } });
    expect(r.enabled).toBe(false);
    expect(r.fixes).toEqual([]);
    expect(r.scenes).toEqual(scenes);
  });

  it("reads QUALITY_GATE env (default on)", () => {
    expect(qualityGateConfigFromEnv({}).enabled).toBe(true);
    expect(qualityGateConfigFromEnv({ QUALITY_GATE: "0" }).enabled).toBe(false);
    expect(qualityGateConfigFromEnv({ QUALITY_GATE: "false" }).enabled).toBe(false);
    expect(qualityGateConfigFromEnv({ QUALITY_GATE_REPEAT_WINDOW: "5" }).repeatWindow).toBe(5);
    expect(qualityGateConfigFromEnv({ QUALITY_GATE_REPEAT_WINDOW: "x" }).repeatWindow).toBe(3);
  });

  describe("repeated clip window", () => {
    it("moves the later scene to a free window of the same clip", () => {
      const scenes = [scene(1, { assetId: "x", sourceStartMs: 0 }), scene(2, { assetId: "x", sourceStartMs: 2_000 })];
      const r = runQualityGate({ scenes, assets: [asset("x")], targetSec: 10 });
      expect(r.fixes).toEqual([{ type: "window_changed", sceneId: "s2", assetId: "x", fromStartMs: 2_000, toStartMs: 5_000, reason: "repeat" }]);
      expect(r.scenes[1]!.sourceStartMs).toBe(5_000);
      expect(r.checks.find((c) => c.name === "repeat_scenes")!.status).toBe("fixed");
    });

    it("ignores non-overlapping windows of the same clip and scenes beyond N", () => {
      const ok = runQualityGate({ scenes: [scene(1, { assetId: "x", sourceStartMs: 0 }), scene(2, { assetId: "x", sourceStartMs: 6_000 })], assets: [asset("x")], targetSec: 10 });
      expect(ok.fixes).toEqual([]);
      const far = [scene(1, { assetId: "x" }), scene(2), scene(3), scene(4), scene(5, { assetId: "x" })];
      const r = runQualityGate({ scenes: far, assets: [asset("x"), ...[2, 3, 4].map((n) => asset(`a${n}`))], targetSec: 25, config: { repeatWindow: 3 } });
      expect(r.checks.find((c) => c.name === "repeat_scenes")!.status).toBe("ok");
    });

    it("swaps to another clip of the job when the clip has no free window (single-scene segment)", () => {
      const scenes = [scene(1, { assetId: "x", sourceStartMs: 0, sourceDurationMs: 5_000 }), scene(2, { assetId: "x", sourceStartMs: 0, sourceDurationMs: 5_000 })];
      const r = runQualityGate({ scenes, assets: [asset("x", { durationMs: 6_000 }), asset("y")], targetSec: 10 });
      expect(r.fixes).toMatchObject([{ type: "source_swapped", sceneId: "s2", segmentId: "g2", fromAssetId: "x", toAssetId: "y", reason: "repeat" }]);
      expect(r.scenes[1]!.assetId).toBe("y");
    });

    it("warns (does not fail) when nothing can fix the repeat", () => {
      const scenes = [scene(1, { assetId: "x", sourceStartMs: 0 }), scene(2, { assetId: "x", sourceStartMs: 0 })];
      const r = runQualityGate({ scenes, assets: [asset("x", { durationMs: 6_000 })], targetSec: 10 });
      expect(r.failure).toBeNull();
      expect(r.warnings.map((w) => w.code)).toContain("repeat_unfixed");
      expect(r.checks.find((c) => c.name === "repeat_scenes")!.status).toBe("warning");
    });

    it("does not treat scenes of the same segment as repeats", () => {
      const scenes = [scene(1, { assetId: "x", segmentId: "g", sourceStartMs: 0 }), scene(2, { assetId: "x", segmentId: "g", sourceStartMs: 0 })];
      expect(runQualityGate({ scenes, assets: [asset("x")], targetSec: 10 }).fixes).toEqual([]);
    });

    it("never moves a multi-scene segment to another clip", () => {
      const scenes = [scene(1, { assetId: "x", sourceStartMs: 0 }), scene(2, { assetId: "x", segmentId: "g", sourceStartMs: 0 }), scene(3, { assetId: "x", segmentId: "g", sourceStartMs: 0 })];
      const r = runQualityGate({ scenes, assets: [asset("x", { durationMs: 6_000 }), asset("y")], targetSec: 15 });
      expect(r.fixes.every((f) => f.type === "window_changed")).toBe(true);
    });

    it("flags the same still image on adjacent scenes", () => {
      const scenes = [scene(1, { assetId: "i", kind: "image", sourceStartMs: null, sourceDurationMs: null }), scene(2, { assetId: "i", kind: "image", sourceStartMs: null, sourceDurationMs: null })];
      const r = runQualityGate({ scenes, assets: [asset("i", { kind: "image", durationMs: null })], targetSec: 10 });
      expect(r.warnings.map((w) => w.code)).toContain("repeat_unfixed");
    });
  });

  describe("total duration", () => {
    it("warns outside +-10 s of target and not inside", () => {
      const scenes = [scene(1), scene(2)];
      const assets = [asset("a1"), asset("a2")];
      expect(runQualityGate({ scenes, assets, targetSec: 15 }).warnings).toEqual([]);
      const r = runQualityGate({ scenes, assets, targetSec: 30 });
      expect(r.warnings[0]).toMatchObject({ code: "duration_out_of_band" });
      expect(r.duration).toMatchObject({ inBand: false, deviationSec: -10 });
      expect(r.failure).toBeNull();
    });
  });

  describe("subtitle lines", () => {
    it("estimates lines for latin and CJK text", () => {
      expect(estimateCaptionLines("")).toBe(0);
      expect(estimateCaptionLines("Xin chao cac ban")).toBe(1);
      expect(estimateCaptionLines("あ".repeat(28))).toBe(2);
      expect(estimateCaptionLines("あ".repeat(29))).toBe(3);
      expect(estimateCaptionLines("word ".repeat(30))).toBeGreaterThan(2);
    });
    it("reports scenes over 2 lines without blocking", () => {
      const r = runQualityGate({ scenes: [scene(1, { narration: "あ".repeat(60) })], assets: [asset("a1")], targetSec: 5 });
      expect(r.warnings).toMatchObject([{ code: "subtitle_over_lines", sceneId: "s1" }]);
      expect(r.failure).toBeNull();
    });
  });

  describe("minimum resolution", () => {
    it("swaps a low-resolution clip for another that is usable", () => {
      const r = runQualityGate({ scenes: [scene(1)], assets: [asset("a1", { widthPx: 320, heightPx: 240 }), asset("good")], targetSec: 5 });
      expect(r.fixes).toMatchObject([{ type: "source_swapped", fromAssetId: "a1", toAssetId: "good", reason: "low_resolution" }]);
    });
    it("never swaps to another low-resolution clip; warns instead", () => {
      const r = runQualityGate({ scenes: [scene(1)], assets: [asset("a1", { widthPx: 320, heightPx: 240 }), asset("b", { widthPx: 300, heightPx: 300 })], targetSec: 5 });
      expect(r.fixes).toEqual([]);
      expect(r.warnings.map((w) => w.code)).toContain("low_resolution");
    });
    it("ignores unknown resolution", () => {
      const r = runQualityGate({ scenes: [scene(1)], assets: [asset("a1", { widthPx: null, heightPx: null })], targetSec: 5 });
      expect(r.checks.find((c) => c.name === "min_resolution")!.status).toBe("ok");
    });
  });

  describe("missing/degraded source", () => {
    it("reports quality_degraded and never fails", () => {
      const scenes = [scene(1, { assetId: "bg", kind: "image", sourceStartMs: null, sourceDurationMs: null, degradedTier: "brand_background" }), scene(2, { assetId: null, kind: null, sourceStartMs: null, sourceDurationMs: null })];
      const r = runQualityGate({ scenes, assets: [asset("bg", { kind: "image", durationMs: null })], targetSec: 10 });
      expect(r.failure).toBeNull();
      expect(r.degraded).toEqual({ count: 1, sceneIds: ["s1"], tiers: { brand_background: 1 } });
      expect(r.warnings.map((w) => w.code)).toContain("quality_degraded");
    });
  });

  it("fails early with a clear reason on an invalid video range", () => {
    const r = runQualityGate({ scenes: [scene(1, { sourceDurationMs: -5 })], assets: [asset("a1")], targetSec: 5 });
    expect(r.failure).toMatchObject({ code: "invalid_range", sceneId: "s1" });
    expect(r.checks[0]).toMatchObject({ name: "range_valid", status: "failed" });
  });
});
