import { describe, expect, it } from "vitest";
import { isValidMediaAssetTransform, parseMediaAssetTransform } from "./media-lineage.js";

/** VE2E-67: crop-plan lineage on a derivative's `transform` (additive; legacy values parse exactly as before). */
const crop = {
  planSha256: "a".repeat(64),
  planVersion: "crop-plan.v1",
  mode: "keyframes",
  zoomPermille: 1250,
  overlayUnavoidable: true,
  residualOverlayPct: 12,
  subjectCoveragePct: 96,
  cropProfileVersion: "crop-apply.v1",
};

describe("MediaAssetTransform.crop", () => {
  it("round-trips a crop summary and leaves the key absent when there is none (legacy parse unchanged)", () => {
    const withCrop = { range: { startMs: 0, durationMs: 4000 }, stripAudio: true, tool: { name: "ffmpeg", version: "8" }, profileVersion: "clip-prepare.v1", crop };
    expect(parseMediaAssetTransform(withCrop)).toEqual(withCrop);
    expect(isValidMediaAssetTransform(withCrop)).toBe(true);
    const legacy = parseMediaAssetTransform({ stripAudio: true });
    expect(legacy).toEqual({ range: null, stripAudio: true, tool: null, profileVersion: null });
    expect("crop" in legacy!).toBe(false);
  });

  it("accepts an image derivative (range null) with a crop", () => {
    expect(parseMediaAssetTransform({ range: null, stripAudio: true, crop })?.crop?.planSha256).toBe("a".repeat(64));
  });

  it.each([
    ["bad digest", { ...crop, planSha256: "xyz" }],
    ["unknown mode", { ...crop, mode: "pan" }],
    ["pct out of range", { ...crop, residualOverlayPct: 101 }],
    ["missing flag", { ...crop, overlayUnavoidable: undefined }],
    ["not an object", "crop"],
  ])("a malformed crop makes the whole transform unreadable (never silently dropped): %s", (_name, bad) => {
    expect(parseMediaAssetTransform({ stripAudio: true, crop: bad })).toBeNull();
  });
});
