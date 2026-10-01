import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFrameExtractJob, MAX_FRAME_EXTRACT_BYTES, MediaJobClient, type FrameExtractJob } from "@lyonix/media-jobs";
import { InMemoryMediaJobBroker } from "@lyonix/media-jobs/testing";
import { ClipPrepareProcessor, jobDirName, MEDIA_JOBS_DIR } from "./clip-prepare.js";
import { startClipPrepareConsumer } from "./consumer.js";
import { FrameExtractProcessor } from "./frame-extract.js";
import type { ProcessRunner } from "./process.js";
import { sweepExpiredMediaJobs } from "./ttl-sweep.js";

const SOURCE = "projects/p1/assets/long.mp4";

/** Smallest readable JPEG header (SOI + SOF0 with dimensions) padded to `size` bytes. */
const jpeg = (width: number, height: number, size: number): Buffer => {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 1)]);
};

type FakeOptions = { duration?: number; sizesByQuality?: Record<string, number>; noVideo?: boolean };

const fakeRunner = (options: FakeOptions = {}) => {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  const runner: ProcessRunner = async (binary, args) => {
    calls.push({ binary, args });
    if (binary === "ffprobe") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: options.noVideo ? [{ codec_type: "audio", codec_name: "aac" }] : [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "30/1" }],
          format: { format_name: "mov,mp4", duration: String(options.duration ?? 90), start_time: "0" },
        }),
        stderrTail: "",
      };
    }
    const quality = args[args.indexOf("-q:v") + 1]!;
    await writeFile(args[args.length - 1]!, jpeg(640, 360, options.sizesByQuality?.[quality] ?? 40_000));
    return { exitCode: 0, stdout: "", stderrTail: "" };
  };
  return { runner, ffmpegCalls: () => calls.filter((c) => c.binary === "ffmpeg") };
};

let mediaRoot: string;
const cfg = () => ({ mediaRoot, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", jobTimeoutMs: 5000, maxAttempts: 2 });
const job = (overrides: Partial<FrameExtractJob> = {}): FrameExtractJob => ({
  ...buildFrameExtractJob({ jobKey: "frames:test-1", source: { relativePath: SOURCE, mediaAssetVersionId: "mav-1" }, frameCount: 4 }),
  ...overrides,
});

beforeEach(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), "lyonix-frame-extract-"));
  await mkdir(join(mediaRoot, "projects/p1/assets"), { recursive: true });
  await writeFile(join(mediaRoot, SOURCE), "source-bytes");
  await mkdir(join(mediaRoot, "_quarantine"), { recursive: true });
  await writeFile(join(mediaRoot, "_quarantine", "q.mp4"), "q");
});
afterEach(async () => { await rm(mediaRoot, { recursive: true, force: true }); });

describe("FrameExtractProcessor", () => {
  it("extracts N JPEG frames into a working-class job dir with checksum, size and 7-day expiry", async () => {
    const fake = fakeRunner();
    const now = new Date("2026-10-01T00:00:00.000Z");
    const result = await new FrameExtractProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v", now: () => now }).handle(job());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames).toHaveLength(4);
    expect(result.frames[0]).toMatchObject({ mimeType: "image/jpeg", width: 640, height: 360, bytes: 40_000 });
    expect(result.frames[0]!.relativePath).toBe(`${MEDIA_JOBS_DIR}/${jobDirName("frames:test-1")}/frame-0.jpg`);
    expect(result.frames.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(result).toMatchObject({ retentionClass: "working", expiresAt: "2026-10-08T00:00:00.000Z", skippedFrames: 0, source: { durationMs: 90_000, mediaAssetVersionId: "mav-1" } });
    expect(fake.ffmpegCalls()).toHaveLength(4);
  });

  it("is idempotent by jobKey: a second delivery returns the stored frames without running FFmpeg again", async () => {
    const fake = fakeRunner();
    const processor = new FrameExtractProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    await processor.handle(job());
    const callsAfterFirst = fake.ffmpegCalls().length;
    const again = await processor.handle(job());
    expect(again.ok && again.reused).toBe(true);
    expect(fake.ffmpegCalls()).toHaveLength(callsAfterFirst);
  });

  it("rejects the same jobKey with a different input (JOB_KEY_CONFLICT)", async () => {
    const processor = new FrameExtractProcessor({ config: cfg(), runner: fakeRunner().runner, ffmpegVersion: "v" });
    await processor.handle(job());
    const conflict = await processor.handle(job({ frameCount: 2 }));
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.error.code).toBe("JOB_KEY_CONFLICT");
  });

  it("never reads outside MEDIA_ROOT or from quarantine, and rejects invalid jobs", async () => {
    const processor = new FrameExtractProcessor({ config: cfg(), runner: fakeRunner().runner, ffmpegVersion: "v" });
    const escaping = await processor.handle(job({ jobKey: "frames:escape", source: { relativePath: "../outside.mp4" } }));
    expect(!escaping.ok && escaping.error.code).toBe("INVALID_JOB");
    const quarantined = await processor.handle(job({ jobKey: "frames:quarantine", source: { relativePath: "_quarantine/q.mp4" } }));
    expect(!quarantined.ok && quarantined.error.code).toBe("SOURCE_UNSAFE_PATH");
    const tooMany = await processor.handle({ ...job(), jobKey: "frames:many", frameCount: 99 });
    expect(!tooMany.ok && tooMany.error.code).toBe("INVALID_JOB");
  });

  it("retries a frame at a lower JPEG quality when it exceeds the byte cap, and reports frames that never fit", async () => {
    const fake = fakeRunner({ sizesByQuality: { "4": MAX_FRAME_EXTRACT_BYTES + 1, "8": 90_000 } });
    const ok = await new FrameExtractProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" }).handle(job({ frameCount: 2 }));
    expect(ok.ok && ok.frames.every((f) => f.bytes === 90_000)).toBe(true);

    const never = fakeRunner({ sizesByQuality: { "4": MAX_FRAME_EXTRACT_BYTES + 1, "8": MAX_FRAME_EXTRACT_BYTES + 1, "14": MAX_FRAME_EXTRACT_BYTES + 1, "22": MAX_FRAME_EXTRACT_BYTES + 1 } });
    const failed = await new FrameExtractProcessor({ config: cfg(), runner: never.runner, ffmpegVersion: "v" }).handle(job({ jobKey: "frames:big" }));
    expect(!failed.ok && failed.error.code).toBe("OUTPUT_INVALID");
  });

  it("fails with NO_VIDEO_STREAM for an audio-only source", async () => {
    const result = await new FrameExtractProcessor({ config: cfg(), runner: fakeRunner({ noVideo: true }).runner, ffmpegVersion: "v" }).handle(job({ jobKey: "frames:audio" }));
    expect(!result.ok && result.error.code).toBe("NO_VIDEO_STREAM");
  });
});

describe("frame.extract over the media queue", () => {
  it("is routed by the consumer next to clip.prepare and answered through MediaJobClient.extractFrames", async () => {
    const broker = new InMemoryMediaJobBroker();
    const fake = fakeRunner();
    const clip = new ClipPrepareProcessor({ config: { ...cfg(), copyToleranceMs: 1000 }, runner: fake.runner, ffmpegVersion: "v" });
    const frames = new FrameExtractProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const consumer = await startClipPrepareConsumer({ channel: broker.createChannel(), queue: "q.media", prefetch: 2, processor: clip, frameProcessor: frames });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q.media", defaultTimeoutMs: 5_000 });
    const result = await client.extractFrames({ jobKey: "frames:rpc", source: { relativePath: SOURCE }, frameCount: 3 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.frames).toHaveLength(3);
    await client.close();
    consumer.stop();
    await consumer.drain();
  });

  it("answers frame.extract with INVALID_JOB when the worker has no frame processor", async () => {
    const broker = new InMemoryMediaJobBroker();
    const clip = new ClipPrepareProcessor({ config: { ...cfg(), copyToleranceMs: 1000 }, runner: fakeRunner().runner, ffmpegVersion: "v" });
    const consumer = await startClipPrepareConsumer({ channel: broker.createChannel(), queue: "q.media2", prefetch: 1, processor: clip });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q.media2", defaultTimeoutMs: 5_000 });
    const result = await client.extractFrames({ jobKey: "frames:none", source: { relativePath: SOURCE }, frameCount: 1 });
    expect(!result.ok && result.error.code).toBe("INVALID_JOB");
    await client.close();
    consumer.stop();
    await consumer.drain();
  });
});

describe("TTL sweep", () => {
  it("removes an expired frame.extract job directory", async () => {
    const processor = new FrameExtractProcessor({ config: cfg(), runner: fakeRunner().runner, ffmpegVersion: "v", now: () => new Date("2026-10-01T00:00:00.000Z") });
    await processor.handle(job());
    const root = join(mediaRoot, MEDIA_JOBS_DIR);
    expect(await readdir(root)).toHaveLength(1);
    expect((await sweepExpiredMediaJobs(mediaRoot, new Date("2026-10-05T00:00:00.000Z"))).removed).toBe(0);
    expect((await sweepExpiredMediaJobs(mediaRoot, new Date("2026-10-09T00:00:00.000Z"))).removed).toBe(1);
    expect(await readdir(root)).toHaveLength(0);
  });
});
