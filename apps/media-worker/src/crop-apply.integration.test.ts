import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClipPrepareJob, type ClipPrepareJob, type ClipPrepareResult, type ClipPrepareSuccess, type ReframeCropPlan } from "@lyonix/media-jobs";
import { buildProbeArgs, parseProbeJson } from "./clip-plan.js";
import { ClipPrepareProcessor } from "./clip-prepare.js";
import { runProcess } from "./process.js";

/**
 * VE2E-67 integration: applies crop plans with the REAL ffmpeg on tiny lavfi fixtures and checks the OUTPUT PIXELS
 * (size, which region survived, how the window follows the plan over time, -an). Skipped with a message when FFmpeg
 * (with libx264) is missing. Synthetic fixtures prove the mechanics only - not subject-keeping quality on real video.
 */
const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH?.trim() || "ffprobe";

const detect = (): { ok: true; version: string } | { ok: false; reason: string } => {
  const ffmpeg = spawnSync(ffmpegPath, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (ffmpeg.error || ffmpeg.status !== 0) return { ok: false, reason: `${ffmpegPath} not runnable` };
  const probe = spawnSync(ffprobePath, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return { ok: false, reason: `${ffprobePath} not runnable` };
  const encoders = spawnSync(ffmpegPath, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (!encoders.stdout?.includes("libx264")) return { ok: false, reason: "ffmpeg build has no libx264 encoder" };
  return { ok: true, version: ffmpeg.stdout.split(/\r?\n/)[0] ?? "ffmpeg" };
};
const availability = detect();
if (!availability.ok) console.warn(`[media-worker] SKIPPING crop-apply integration tests: ${availability.reason}.`);

const generate = (args: string[]) => {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture generation failed: ${result.stderr}`);
};

type Rgb = { width: number; height: number; data: Buffer };
/** Decodes one frame of `file` (at `atSec`) scaled to `width x height` as raw RGB. */
const frameRgb = (file: string, atSec: number | null, width: number, height: number): Rgb => {
  const args = ["-hide_banner", "-nostdin", "-v", "error", ...(atSec === null ? [] : ["-ss", String(atSec)]), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:${height}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
  const result = spawnSync(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || result.stdout.length !== width * height * 3) throw new Error(`frame decode failed: ${result.stderr?.toString()}`);
  return { width, height, data: result.stdout };
};
const px = (frame: Rgb, x: number, y: number) => {
  const i = (y * frame.width + x) * 3;
  return { r: frame.data[i]!, g: frame.data[i + 1]!, b: frame.data[i + 2]! };
};
const isRed = (c: { r: number; g: number; b: number }) => c.r > 190 && c.g < 90 && c.b < 90;
const isBlue = (c: { r: number; g: number; b: number }) => c.b > 190 && c.r < 90 && c.g < 90;
const share = (frame: Rgb, test: (c: { r: number; g: number; b: number }) => boolean): number => {
  let hits = 0;
  for (let y = 0; y < frame.height; y += 1) for (let x = 0; x < frame.width; x += 1) if (test(px(frame, x, y))) hits += 1;
  return hits / (frame.width * frame.height);
};
/** Centre column (0..width) of the red block, or null when absent. */
const redCenterX = (frame: Rgb): number | null => {
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      if (isRed(px(frame, x, y))) {
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
  }
  return max < 0 ? null : (min + max) / 2;
};

const plan = (overrides: Partial<ReframeCropPlan> & Pick<ReframeCropPlan, "sourceWidthPx" | "sourceHeightPx" | "keyframes">): ReframeCropPlan => ({
  version: "crop-plan.v1",
  targetWidthPx: 1080,
  targetHeightPx: 1920,
  durationMs: 4000,
  zoomPermille: 1000,
  mode: overrides.keyframes.length === 1 ? "static" : "keyframes",
  primarySubjectId: "s1",
  overlayUnavoidable: false,
  residualOverlayPct: 0,
  subjectCoveragePct: 100,
  ...overrides,
});

describe.skipIf(!availability.ok)("clip.prepare applies a cropPlan with real FFmpeg (VE2E-67)", () => {
  let root: string;
  let processor: ClipPrepareProcessor;
  const version = availability.ok ? availability.version : "";
  const SPLIT = "projects/p/assets/split-1280x720.mp4"; // left half red, right half blue, with audio
  const MOVER = "projects/p/assets/mover-1280x720.mp4"; // grey, a 160px red block moving right 200 px/s
  const TALL = "projects/p/assets/tall-720x1560.mp4"; // top 780 rows red, bottom blue
  const PORTRAIT = "projects/p/assets/portrait-720x1280.mp4"; // copy-eligible H.264, 1s GOP
  const STILL = "projects/p/assets/split-1280x720.png";

  const run = async (overrides: Partial<ClipPrepareJob> & { jobKey: string }): Promise<ClipPrepareResult> =>
    processor.handle({ ...buildClipPrepareJob({ jobKey: overrides.jobKey, source: { relativePath: SPLIT }, startMs: 0, durationMs: 2000, stripAudio: true }), ...overrides });
  const ok = (result: ClipPrepareResult): ClipPrepareSuccess => {
    if (!result.ok) throw new Error(`job failed: ${result.error.code}: ${result.error.message}`);
    return result;
  };
  const probe = async (relativePath: string) => {
    const result = await runProcess(ffprobePath, buildProbeArgs(join(root, relativePath)), { timeoutMs: 20_000 });
    const parsed = parseProbeJson(result.stdout);
    if (!parsed.ok) throw new Error(`probe failed ${parsed.reason}`);
    return parsed.probe;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lyonix-crop-it-"));
    await mkdir(join(root, "projects/p/assets"), { recursive: true });
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p"];
    generate([
      "-f", "lavfi", "-i", "color=c=red:s=640x720:r=30:d=4", "-f", "lavfi", "-i", "color=c=blue:s=640x720:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-filter_complex", "[0:v][1:v]hstack=inputs=2[v]", "-map", "[v]", "-map", "2:a", ...enc, "-c:a", "aac", "-shortest", join(root, SPLIT),
    ]);
    generate([
      "-f", "lavfi", "-i", "color=c=0x303030:s=1280x720:r=30:d=5", "-f", "lavfi", "-i", "color=c=red:s=160x160:r=30:d=5",
      "-filter_complex", "[0:v][1:v]overlay=x='100+t*200':y=280[v]", "-map", "[v]", ...enc, join(root, MOVER),
    ]);
    generate([
      "-f", "lavfi", "-i", "color=c=red:s=720x780:r=30:d=3", "-f", "lavfi", "-i", "color=c=blue:s=720x780:r=30:d=3",
      "-filter_complex", "[0:v][1:v]vstack=inputs=2[v]", "-map", "[v]", ...enc, join(root, TALL),
    ]);
    generate(["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=6", ...enc, join(root, PORTRAIT)]);
    generate(["-f", "lavfi", "-i", "color=c=red:s=640x720", "-f", "lavfi", "-i", "color=c=blue:s=640x720", "-filter_complex", "[0:v][1:v]hstack=inputs=2", "-frames:v", "1", join(root, STILL)]);
    processor = new ClipPrepareProcessor({
      config: { mediaRoot: root, ffmpegPath, ffprobePath, copyToleranceMs: 1000, jobTimeoutMs: 90_000, maxAttempts: 1, ffmpegThreads: 2 },
      runner: runProcess,
      ffmpegVersion: version,
    });
  }, 180_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("static crop of the right half: output is 1080x1920, only blue survives, no audio track (-an)", async () => {
    const result = ok(await run({ jobKey: "crop:static-right", cropPlan: plan({ sourceWidthPx: 1280, sourceHeightPx: 720, keyframes: [{ tMs: 0, xPx: 800, yPx: 0, widthPx: 405, heightPx: 720 }] }) }));
    expect(result.mode).toBe("reencode");
    expect(result.reencodeReasons).toContain("crop_plan");
    expect(result.output).toMatchObject({ width: 1080, height: 1920, hasAudio: false, videoCodec: "h264", mimeType: "video/mp4" });
    expect(result.reframe).toMatchObject({ applied: "crop", mode: "static", planVersion: "crop-plan.v1", zoomPermille: 1000 });
    expect(result.reframe?.cropPlanSha256).toMatch(/^[0-9a-f]{64}$/);
    const outProbe = await probe(result.output.relativePath);
    expect(outProbe.audio).toBeNull();
    const frame = frameRgb(join(root, result.output.relativePath), 1, 108, 192);
    expect(share(frame, isBlue)).toBeGreaterThan(0.98);
    expect(share(frame, isRed)).toBe(0);
  }, 90_000);

  it("static crop of the left half keeps only red (the window position really decides the content)", async () => {
    const result = ok(await run({ jobKey: "crop:static-left", cropPlan: plan({ sourceWidthPx: 1280, sourceHeightPx: 720, keyframes: [{ tMs: 0, xPx: 100, yPx: 0, widthPx: 405, heightPx: 720 }] }) }));
    const frame = frameRgb(join(root, result.output.relativePath), 1, 108, 192);
    expect(share(frame, isRed)).toBeGreaterThan(0.98);
  }, 90_000);

  it("keyframed crop follows a moving subject over time, relative to the cut start (startMs 1000)", async () => {
    // Block centre x(t) = 180 + 200 t. Cut starts at source t = 1 s. Window pans 150 px/s from x = 178, so the block drifts 50 px/s right inside it.
    const cropPlan = plan({
      sourceWidthPx: 1280,
      sourceHeightPx: 720,
      durationMs: 2000,
      keyframes: [{ tMs: 0, xPx: 178, yPx: 0, widthPx: 405, heightPx: 720 }, { tMs: 2000, xPx: 478, yPx: 0, widthPx: 405, heightPx: 720 }],
    });
    const result = ok(await run({ jobKey: "crop:moving", source: { relativePath: MOVER }, startMs: 1000, durationMs: 2000, cropPlan }));
    expect(result.reframe).toMatchObject({ applied: "crop", mode: "keyframes" });
    const out = join(root, result.output.relativePath);
    const centres: Array<{ tau: number; got: number | null; want: number }> = [];
    for (const tau of [0.2, 0.9, 1.6]) {
      const cropX = 178 + 150 * tau;
      const blockCentre = 180 + 200 * (1 + tau);
      const frame = frameRgb(out, tau, 135, 240); // 405 px window -> 135 columns: 3 source px per column
      centres.push({ tau, got: redCenterX(frame), want: (blockCentre - cropX) / 3 });
    }
    for (const { got, want } of centres) {
      expect(got).not.toBeNull();
      expect(Math.abs((got as number) - want)).toBeLessThan(3); // <= 9 source px incl. chroma-aligned x and frame timing
    }
    // The block drifts right inside the window by 50 px/s (= 1.7 columns per 0.1 s): proves the pan is applied over time, not frozen.
    expect(centres[2]!.got! - centres[0]!.got!).toBeGreaterThan(20);
  }, 120_000);

  it("vertical window on a tall (720x1560) source crops rows, not columns", async () => {
    const result = ok(await run({ jobKey: "crop:tall", source: { relativePath: TALL }, startMs: 0, durationMs: 2000, cropPlan: plan({ sourceWidthPx: 720, sourceHeightPx: 1560, keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 720, heightPx: 1280 }] }) }));
    const frame = frameRgb(join(root, result.output.relativePath), 0.5, 54, 96);
    expect(isRed(px(frame, 27, 20))).toBe(true); // 20% down = source row 256 (red)
    expect(isBlue(px(frame, 27, 90))).toBe(true); // 94% down = source row 1200 (blue; red ends at 780)
  }, 90_000);

  it("a whole-frame plan is a no-op for the pixels and keeps stream copy legal on an eligible source", async () => {
    const full = plan({ sourceWidthPx: 720, sourceHeightPx: 1280, keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 720, heightPx: 1280 }] });
    const result = ok(await run({ jobKey: "crop:full-frame", source: { relativePath: PORTRAIT }, startMs: 2000, durationMs: 2000, cropPlan: full }));
    expect(result.mode).toBe("copy");
    expect(result.reframe).toMatchObject({ applied: "full_frame" });
    const cropped = plan({ sourceWidthPx: 720, sourceHeightPx: 1280, keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 600, heightPx: 1067 }] });
    const reencoded = ok(await run({ jobKey: "crop:zoomed", source: { relativePath: PORTRAIT }, startMs: 2000, durationMs: 2000, cropPlan: cropped }));
    expect(reencoded.mode).toBe("reencode");
    expect(reencoded.reencodeReasons).toContain("crop_plan");
    expect(reencoded.output).toMatchObject({ width: 1080, height: 1920 });
  }, 120_000);

  it("rejects a plan computed for a different source size instead of cutting the wrong area", async () => {
    const wrong = plan({ sourceWidthPx: 1920, sourceHeightPx: 1080, keyframes: [{ tMs: 0, xPx: 0, yPx: 0, widthPx: 405, heightPx: 720 }] });
    const result = await run({ jobKey: "crop:wrong-size", cropPlan: wrong });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "INVALID_JOB", retryable: false });
  }, 60_000);

  it("is idempotent by jobKey and the crop plan is part of the identity", async () => {
    const a = plan({ sourceWidthPx: 1280, sourceHeightPx: 720, keyframes: [{ tMs: 0, xPx: 800, yPx: 0, widthPx: 405, heightPx: 720 }] });
    const b = plan({ sourceWidthPx: 1280, sourceHeightPx: 720, keyframes: [{ tMs: 0, xPx: 100, yPx: 0, widthPx: 405, heightPx: 720 }] });
    const first = ok(await run({ jobKey: "crop:idem", cropPlan: a }));
    const second = ok(await run({ jobKey: "crop:idem", cropPlan: a }));
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.output.sha256).toBe(first.output.sha256);
    const conflict = await run({ jobKey: "crop:idem", cropPlan: b });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("JOB_KEY_CONFLICT");
    const noPlan = await run({ jobKey: "crop:idem" });
    expect(noPlan.ok).toBe(false); // legacy (plan-less) input under the same key is a different input
  }, 120_000);

  it("still image + crop plan -> one 1080x1920 JPEG of the planned window; without a plan -> centre cover", async () => {
    const jobBase = { source: { relativePath: STILL, kind: "image" as const }, startMs: 0, durationMs: 0 };
    const planned = ok(await run({ jobKey: "img:crop", ...jobBase, cropPlan: plan({ sourceWidthPx: 1280, sourceHeightPx: 720, keyframes: [{ tMs: 0, xPx: 800, yPx: 0, widthPx: 405, heightPx: 720 }] }) }));
    expect(planned.output).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1920, hasAudio: false, durationMs: 0 });
    expect(planned.output.relativePath.endsWith("/clip.jpg")).toBe(true);
    expect(planned.source.kind).toBe("image");
    const blue = frameRgb(join(root, planned.output.relativePath), null, 108, 192);
    expect(share(blue, isBlue)).toBeGreaterThan(0.97);
    const centre = ok(await run({ jobKey: "img:cover", ...jobBase }));
    const frame = frameRgb(join(root, centre.output.relativePath), null, 108, 192);
    // centre cover of a red|blue image: the middle strip is the seam, the left edge red, the right edge blue
    expect(isRed(px(frame, 2, 96))).toBe(true);
    expect(isBlue(px(frame, 105, 96))).toBe(true);
    expect(centre.reframe ?? null).toBeNull();
  }, 120_000);
});
