import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildClipPrepareJob, buildClipPrepareJobKey, CLIP_PREPARE_PROFILE_VERSION, clipPrepareFingerprint, cropPlanDigest, validateClipPrepareJob } from "./contract.js";

const base = () =>
  buildClipPrepareJob({
    jobKey: "clip:abc",
    source: { relativePath: "projects/p1/assets/aa.mp4", mediaAssetVersionId: "mav-1" },
    startMs: 1000,
    durationMs: 6000,
    stripAudio: true,
  });

const crop = (overrides: Record<string, unknown> = {}) => ({
  version: "crop-plan.v1",
  sourceWidthPx: 1280,
  sourceHeightPx: 720,
  targetWidthPx: 1080,
  targetHeightPx: 1920,
  durationMs: 4000,
  zoomPermille: 1000,
  mode: "keyframes",
  keyframes: [
    { tMs: 0, xPx: 0, yPx: 0, widthPx: 405, heightPx: 720 },
    { tMs: 2000, xPx: 500, yPx: 0, widthPx: 405, heightPx: 720 },
  ],
  primarySubjectId: "s1",
  overlayUnavoidable: false,
  residualOverlayPct: 0,
  subjectCoveragePct: 100,
  ...overrides,
});
const withCrop = (plan: unknown) => ({ ...base(), cropPlan: plan });

describe("cropPlan / image extensions of clip.prepare (VE2E-67)", () => {
  it("without a cropPlan / image the key and fingerprint keep the pre-VE2E-67 shape (only the profile version moves: v3 since VE2E-143)", () => {
    const legacyKey = `clip:${createHash("sha256").update(JSON.stringify(["mav-1", 1000, 6000, true, CLIP_PREPARE_PROFILE_VERSION])).digest("hex").slice(0, 40)}`;
    expect(buildClipPrepareJobKey({ sourceMediaAssetVersionId: "mav-1", startMs: 1000, durationMs: 6000, stripAudio: true })).toBe(legacyKey);
    const job = base();
    const legacyFingerprint = createHash("sha256")
      .update(JSON.stringify({ profile: CLIP_PREPARE_PROFILE_VERSION, source: job.source.relativePath, startMs: 1000, durationMs: 6000, stripAudio: true, target: job.target }))
      .digest("hex");
    expect(clipPrepareFingerprint(job)).toBe(legacyFingerprint);
  });

  it("the crop plan changes the jobKey and the fingerprint; the same plan content hashes the same", () => {
    const keyOf = (cropPlan?: ReturnType<typeof crop>) =>
      buildClipPrepareJobKey({ sourceMediaAssetVersionId: "mav-1", startMs: 1000, durationMs: 6000, stripAudio: true, ...(cropPlan ? { cropPlan: cropPlan as never } : {}) });
    expect(keyOf(crop())).not.toBe(keyOf());
    expect(keyOf(crop())).toBe(keyOf(JSON.parse(JSON.stringify(crop()))));
    expect(keyOf(crop({ keyframes: [{ tMs: 0, xPx: 7, yPx: 0, widthPx: 405, heightPx: 720 }], mode: "static" }))).not.toBe(keyOf(crop()));
    expect(cropPlanDigest(crop() as never)).toMatch(/^[0-9a-f]{64}$/);
    const a = validateClipPrepareJob(withCrop(crop()));
    const b = validateClipPrepareJob(base());
    expect(a.ok && b.ok && clipPrepareFingerprint(a.value) !== clipPrepareFingerprint(b.value)).toBe(true);
    expect(buildClipPrepareJobKey({ sourceMediaAssetVersionId: "mav-1", startMs: 0, durationMs: 0, stripAudio: true, kind: "image" })).not.toBe(
      buildClipPrepareJobKey({ sourceMediaAssetVersionId: "mav-1", startMs: 0, durationMs: 0, stripAudio: true }),
    );
  });

  it("accepts a valid plan and carries it through validation; null plan stays plan-less", () => {
    const result = validateClipPrepareJob(withCrop(crop()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.cropPlan?.keyframes).toHaveLength(2);
    const none = validateClipPrepareJob({ ...base(), cropPlan: null });
    expect(none.ok && none.value.cropPlan === undefined).toBe(true);
  });

  it.each([
    ["window outside the frame", crop({ keyframes: [{ tMs: 0, xPx: 900, yPx: 0, widthPx: 405, heightPx: 720 }], mode: "static" })],
    ["not 9:16", crop({ keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 600, heightPx: 720 }], mode: "static" })],
    ["changing window size", crop({ keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 405, heightPx: 720 }, { tMs: 1000, xPx: 0, yPx: 0, widthPx: 360, heightPx: 640 }] })],
    ["tMs not increasing", crop({ keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 405, heightPx: 720 }, { tMs: 0, xPx: 5, yPx: 0, widthPx: 405, heightPx: 720 }] })],
    ["first keyframe not at 0", crop({ keyframes: [{ tMs: 100, xPx: 0, yPx: 0, widthPx: 405, heightPx: 720 }], mode: "static" })],
    ["static with two keyframes", crop({ mode: "static" })],
    ["wrong target", crop({ targetWidthPx: 720 })],
    ["no keyframes", crop({ keyframes: [] })],
    ["fractional pixel", crop({ keyframes: [{ tMs: 0, xPx: 1.5, yPx: 0, widthPx: 405, heightPx: 720 }], mode: "static" })],
  ])("rejects a malformed plan: %s", (_name, plan) => {
    expect(validateClipPrepareJob(withCrop(plan)).ok).toBe(false);
  });

  it("an image job needs no time range (normalised to 0) but still validates kind", () => {
    const image = { ...base(), source: { ...base().source, kind: "image" }, startMs: undefined, durationMs: undefined };
    const result = validateClipPrepareJob(image);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ startMs: 0, durationMs: 0, source: { kind: "image" } });
    expect(validateClipPrepareJob({ ...image, source: { ...base().source, kind: "audio" } }).ok).toBe(false);
    expect(validateClipPrepareJob({ ...base(), source: { ...base().source, kind: "video" }, durationMs: 5 }).ok).toBe(false);
  });
});
