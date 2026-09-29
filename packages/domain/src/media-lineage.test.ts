import { describe, expect, it } from "vitest";
import { isValidMediaAssetTransform, parseMediaAssetTransform } from "./media-lineage.js";

describe("parseMediaAssetTransform", () => {
  it("returns null for originals / empty / malformed values", () => {
    expect(parseMediaAssetTransform(null)).toBeNull();
    expect(parseMediaAssetTransform(undefined)).toBeNull();
    expect(parseMediaAssetTransform({})).toBeNull();
    expect(parseMediaAssetTransform([])).toBeNull();
    expect(parseMediaAssetTransform({ stripAudio: "yes" })).toBeNull();
    expect(parseMediaAssetTransform({ stripAudio: true, range: { startMs: -1, durationMs: 10 } })).toBeNull();
    expect(parseMediaAssetTransform({ stripAudio: true, range: { startMs: 0, durationMs: 0 } })).toBeNull();
    expect(parseMediaAssetTransform({ stripAudio: true, tool: { name: "ffmpeg" } })).toBeNull();
  });

  it("parses a full derivative transform and fills optional fields with null", () => {
    expect(parseMediaAssetTransform({ stripAudio: true })).toEqual({ range: null, stripAudio: true, tool: null, profileVersion: null });
    expect(
      parseMediaAssetTransform({ range: { startMs: 1200, durationMs: 4000 }, stripAudio: true, tool: { name: "ffmpeg", version: "7.1" }, profileVersion: "clip.prepare@1" }),
    ).toEqual({ range: { startMs: 1200, durationMs: 4000 }, stripAudio: true, tool: { name: "ffmpeg", version: "7.1" }, profileVersion: "clip.prepare@1" });
  });
});

describe("isValidMediaAssetTransform", () => {
  it("rejects unknown keys that a tolerant parse would silently drop", () => {
    expect(isValidMediaAssetTransform({ stripAudio: false, range: null })).toBe(true);
    expect(isValidMediaAssetTransform({ stripAudio: false, extra: 1 })).toBe(false);
    expect(isValidMediaAssetTransform({})).toBe(false);
  });
});
