import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClipPrepareJob, MediaJobClient, type ClipPrepareJobInput } from "@lyonix/media-jobs";
import { InMemoryMediaJobBroker } from "@lyonix/media-jobs/testing";
import { ClipPrepareProcessor, sha256File } from "./clip-prepare.js";
import { parseProbeJson, buildProbeArgs } from "./clip-plan.js";
import { startClipPrepareConsumer } from "./consumer.js";
import { runProcess } from "./process.js";

/**
 * VE2E-36 integration: runs the REAL ffmpeg/ffprobe on tiny clips generated on the fly
 * with lavfi (no committed binaries). Skipped with a clear message when FFmpeg (with
 * libx264) is not installed; set FFMPEG_PATH / FFPROBE_PATH to point at custom binaries.
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
if (!availability.ok) {
  console.warn(`[media-worker] SKIPPING real-FFmpeg integration tests: ${availability.reason}. Install FFmpeg (with libx264) or set FFMPEG_PATH/FFPROBE_PATH to run them.`);
}

const generate = (args: string[]) => {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture generation failed: ${result.stderr}`);
};

describe.skipIf(!availability.ok)("clip.prepare with real FFmpeg", () => {
  let mediaRoot: string;
  let processor: ClipPrepareProcessor;
  const PORTRAIT = "projects/p/assets/portrait-720x1280-h264.mp4";
  const MPEG4 = "projects/p/assets/landscape-1280x720-mpeg4.mp4";
  const version = availability.ok ? availability.version : "";

  const probeOutput = async (relativePath: string) => {
    const result = await runProcess(ffprobePath, buildProbeArgs(join(mediaRoot, relativePath)), { timeoutMs: 20_000 });
    const parsed = parseProbeJson(result.stdout);
    if (!parsed.ok) throw new Error(`probe failed ${parsed.reason}`);
    return parsed.probe;
  };

  const input = (overrides: Partial<ClipPrepareJobInput>): ClipPrepareJobInput => ({
    jobKey: "clip:it",
    source: { relativePath: PORTRAIT, mediaAssetVersionId: "mav-it" },
    startMs: 2000,
    durationMs: 4000,
    stripAudio: true,
    ...overrides,
  });

  beforeAll(async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), "lyonix-media-it-"));
    await mkdir(join(mediaRoot, "projects/p/assets"), { recursive: true });
    // 12s portrait H.264 (1s GOP, no scene-cut keyframes) + AAC tone: copy-eligible
    generate([
      "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", join(mediaRoot, PORTRAIT),
    ]);
    // 5s landscape MPEG-4 Part 2 + AAC: must be re-encoded to 1080x1920 H.264
    generate([
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=220:duration=5",
      "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-shortest", join(mediaRoot, MPEG4),
    ]);
    processor = new ClipPrepareProcessor({
      config: { mediaRoot, ffmpegPath, ffprobePath, copyToleranceMs: 1000, jobTimeoutMs: 60_000, maxAttempts: 1, ffmpegThreads: 2 },
      runner: runProcess,
      ffmpegVersion: version,
    });
  }, 120_000);

  afterAll(async () => {
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
  });

  it("stream-copies a <=1080p H.264 source on a keyframe and strips audio (-an)", async () => {
    const result = await processor.handle(buildClipPrepareJob(input({ jobKey: "clip:it-copy", startMs: 2000, durationMs: 4000 })));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("copy");
    expect(result.cut.startMs).toBe(2000);
    expect(Math.abs(result.drift.durationMs)).toBeLessThanOrEqual(1000);
    expect(result.output).toMatchObject({ hasAudio: false, videoCodec: "h264", width: 720, height: 1280, retentionClass: "working" });
    expect(await sha256File(join(mediaRoot, result.output.relativePath))).toBe(result.output.sha256);
    const probe = await probeOutput(result.output.relativePath);
    expect(probe.audio).toBeNull();
    expect(Math.abs(probe.durationMs - 4000)).toBeLessThanOrEqual(1000);
  }, 60_000);

  it("re-encodes to 1080x1920 H.264 when keyframe drift exceeds the configured tolerance, keeping audio when asked", async () => {
    const strict = new ClipPrepareProcessor({
      config: { mediaRoot, ffmpegPath, ffprobePath, copyToleranceMs: 200, jobTimeoutMs: 60_000, maxAttempts: 1, ffmpegThreads: 2 },
      runner: runProcess,
      ffmpegVersion: version,
    });
    const result = await strict.handle(buildClipPrepareJob(input({ jobKey: "clip:it-drift", startMs: 2500, durationMs: 3000, stripAudio: false })));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("reencode");
    expect(result.reencodeReasons).toContain("keyframe_start_drift_exceeds_tolerance");
    expect(result.cut.startMs).toBe(2500);
    expect(result.output).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", hasAudio: true });
    expect(Math.abs(result.drift.durationMs)).toBeLessThanOrEqual(200);
  }, 60_000);

  it("re-encodes a non-H.264 landscape source to a 1080x1920 cover crop without audio", async () => {
    const result = await processor.handle(buildClipPrepareJob(input({ jobKey: "clip:it-mpeg4", source: { relativePath: MPEG4, mediaAssetVersionId: null }, startMs: 500, durationMs: 3000 })));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("reencode");
    expect(result.reencodeReasons).toContain("video_codec_mpeg4");
    expect(result.source).toMatchObject({ width: 1280, height: 720, videoCodec: "mpeg4" });
    const probe = await probeOutput(result.output.relativePath);
    expect(probe.video).toMatchObject({ codec: "h264", width: 1080, height: 1920, pixFmt: "yuv420p" });
    expect(probe.audio).toBeNull();
  }, 60_000);

  it("rejects a range past the end of the source", async () => {
    const result = await processor.handle(buildClipPrepareJob(input({ jobKey: "clip:it-range", startMs: 10_000, durationMs: 5000 })));
    expect(result).toMatchObject({ ok: false, error: { code: "RANGE_OUT_OF_BOUNDS" } });
  }, 60_000);

  it("end-to-end over the queue contract: correlated result, then idempotent re-delivery reuses the file", async () => {
    const broker = new InMemoryMediaJobBroker();
    await startClipPrepareConsumer({ channel: broker.createChannel(), queue: "lyonix.media", prefetch: 1, processor });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lyonix.media" });
    const job = input({ jobKey: "clip:it-e2e", startMs: 4000, durationMs: 5000 });
    const first = await client.prepareClip(job, { timeoutMs: 60_000 });
    const second = await client.prepareClip(job, { timeoutMs: 60_000 });
    expect(first).toMatchObject({ ok: true, reused: false });
    expect(second).toMatchObject({ ok: true, reused: true });
    if (first.ok && second.ok) expect(second.output.sha256).toBe(first.output.sha256);
    await client.close();
  }, 120_000);
});

describe.skipIf(!availability.ok)("frame.extract with real FFmpeg (VE2E-30)", () => {
  let mediaRoot: string;
  const LONG = "projects/p/assets/long-960x540.mp4";
  const version = availability.ok ? availability.version : "";

  beforeAll(async () => {
    mediaRoot = await mkdtemp(join(tmpdir(), "lyonix-frames-it-"));
    await mkdir(join(mediaRoot, "projects/p/assets"), { recursive: true });
    generate(["-f", "lavfi", "-i", "testsrc=duration=12:size=960x540:rate=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(mediaRoot, LONG)]);
  }, 60_000);
  afterAll(async () => { await rm(mediaRoot, { recursive: true, force: true }); });

  it("writes real JPEG frames (scaled down to maxWidth, under the byte cap) and reuses them on re-delivery", async () => {
    const { FrameExtractProcessor } = await import("./frame-extract.js");
    const { buildFrameExtractJob, MAX_FRAME_EXTRACT_BYTES } = await import("@lyonix/media-jobs");
    const { readFile } = await import("node:fs/promises");
    const { readJpegSize } = await import("./frame-plan.js");
    const processor = new FrameExtractProcessor({ config: { mediaRoot, ffmpegPath, ffprobePath, jobTimeoutMs: 60_000, maxAttempts: 2 }, runner: runProcess, ffmpegVersion: version });
    const job = buildFrameExtractJob({ jobKey: "frames:it", source: { relativePath: LONG, mediaAssetVersionId: "mav-it" }, frameCount: 4, maxWidth: 480 });
    const result = await processor.handle(job);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(4);
    for (const frame of result.frames) {
      const bytes = await readFile(join(mediaRoot, frame.relativePath));
      expect(bytes.length).toBe(frame.bytes);
      expect(bytes.length).toBeLessThanOrEqual(MAX_FRAME_EXTRACT_BYTES);
      expect(readJpegSize(bytes)).toEqual({ width: 480, height: 270 });
      expect(frame.atMs).toBeGreaterThan(500);
      expect(frame.atMs).toBeLessThan(11_500);
    }
    expect(new Set(result.frames.map((f) => f.sha256)).size).toBe(4); // testsrc changes over time: distinct frames
    const again = await processor.handle(job);
    expect(again.ok && again.reused).toBe(true);
  });
});
