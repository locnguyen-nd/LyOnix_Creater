import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReframeAnalyzeJob, MediaJobClient, type ReframeAnalyzeJob, type ReframeAnalyzeJobInput } from "@lyonix/media-jobs";
import { InMemoryMediaJobBroker } from "@lyonix/media-jobs/testing";
import { ClipPrepareProcessor, jobDirName, MEDIA_JOBS_DIR } from "./clip-prepare.js";
import { startClipPrepareConsumer } from "./consumer.js";
import { MediaJobError } from "./job-errors.js";
import type { ProcessRunner } from "./process.js";
import { buildAnalysisFrameArgs, ReframeAnalyzeProcessor, reframeFrameCount } from "./reframe-analyze.js";
import { analyzeFrames, spreadIndices } from "./reframe/analyze.js";
import { loadReframeConfig } from "./reframe/config.js";
import type { FrameDetector } from "./reframe/detector.js";
import { encodeRgbToJpeg, type Detection, type RgbImage } from "./reframe/image-io.js";
import { sweepExpiredMediaJobs } from "./ttl-sweep.js";

// JPEG encode/decode of ~12 frames per job runs in pure JS; leave headroom when the whole monorepo test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

const SOURCE = "projects/p1/assets/clip.mp4";
const SRC_W = 720;
const SRC_H = 1280;

/** A real, decodable JPEG (flat grey) so the processor's decoder runs on genuine bytes. */
const flatJpeg = (width: number, height: number): Buffer => {
  const data = new Uint8Array(width * height * 3).fill(120);
  return Buffer.from(encodeRgbToJpeg({ width, height, data }, 70));
};

type FakeOptions = { duration?: number; failFfmpegTimes?: number; image?: boolean };
const fakeRunner = (options: FakeOptions = {}) => {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  let ffmpegFailures = options.failFfmpegTimes ?? 0;
  const runner: ProcessRunner = async (binary, args) => {
    calls.push({ binary, args });
    if (binary === "ffprobe") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", codec_name: options.image ? "mjpeg" : "h264", width: SRC_W, height: SRC_H, avg_frame_rate: options.image ? "0/0" : "30/1" }],
          format: options.image ? { format_name: "image2" } : { format_name: "mov,mp4", duration: String(options.duration ?? 20), start_time: "0" },
        }),
        stderrTail: "",
      };
    }
    if (ffmpegFailures > 0) {
      ffmpegFailures -= 1;
      return { exitCode: 1, stdout: "", stderrTail: "boom" };
    }
    await writeFile(args[args.length - 1]!, flatJpeg(252, 448));
    return { exitCode: 0, stdout: "", stderrTail: "" };
  };
  return { runner, ffmpegCalls: () => calls.filter((c) => c.binary === "ffmpeg") };
};

type FakeDetectorOptions = { faces?: (image: RgbImage) => Detection[]; persons?: Detection[]; text?: (image: RgbImage) => Detection[]; delayMs?: number; failWith?: MediaJobError };
const fakeDetector = (options: FakeDetectorOptions = {}) => {
  const counts = { faces: 0, persons: 0, text: 0, textHeights: [] as number[], active: 0, peak: 0 };
  const enter = async () => {
    counts.active += 1;
    counts.peak = Math.max(counts.peak, counts.active);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    counts.active -= 1;
    if (options.failWith) throw options.failWith;
  };
  const detector: FrameDetector = {
    runtime: "fake",
    async detectFaces(image) { counts.faces += 1; await enter(); return options.faces?.(image) ?? []; },
    async detectPersons() { counts.persons += 1; await enter(); return options.persons ?? []; },
    async detectText(image) { counts.text += 1; counts.textHeights.push(image.height); await enter(); return options.text?.(image) ?? []; },
    async close() {},
  };
  return { detector, counts };
};

let mediaRoot: string;
beforeEach(async () => { mediaRoot = await mkdtemp(join(tmpdir(), "reframe-it-")); });
afterEach(async () => { await rm(mediaRoot, { recursive: true, force: true }); });

const mediaCfg = () => ({ mediaRoot, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", jobTimeoutMs: 5000, maxAttempts: 2 });
const reframeCfg = (env: Record<string, string> = {}) => loadReframeConfig({ REFRAME_MODELS_DIR: "/models", ...env }, "/repo", 8);
const job = (overrides: Partial<ReframeAnalyzeJobInput> = {}): ReframeAnalyzeJob => buildReframeAnalyzeJob({ jobKey: "reframe:t1", source: { relativePath: SOURCE, mediaAssetVersionId: "mav-1" }, ...overrides });
const seedSource = async () => {
  await mkdir(join(mediaRoot, "projects/p1/assets"), { recursive: true });
  await writeFile(join(mediaRoot, SOURCE), "x");
};
const person = (x: number, y: number, w: number, h: number, score = 0.9): Detection => ({ box: { x, y, w, h }, score });
const processorWith = (runner: ProcessRunner, detector: FrameDetector, env: Record<string, string> = {}) =>
  new ReframeAnalyzeProcessor({ config: mediaCfg(), reframe: reframeCfg(env), runner, ffmpegVersion: "ffmpeg test", detector });

describe("sampling rules", () => {
  it("samples >= 6 frames for clips of 8 s or more, >= 4 below, capped by REFRAME_MAX_FRAMES", () => {
    expect(reframeFrameCount(8000, 12)).toBeGreaterThanOrEqual(6);
    expect(reframeFrameCount(3000, 12)).toBe(4);
    expect(reframeFrameCount(60_000, 12)).toBe(12);
    expect(reframeFrameCount(60_000, 8)).toBe(8);
    expect(spreadIndices(12, 4)).toEqual([1, 4, 7, 10]);
    expect(spreadIndices(3, 4)).toEqual([0, 1, 2]);
  });
  it("scales analysis frames to a small long side (down only) with a still-image variant without -ss", () => {
    const video = buildAnalysisFrameArgs("in.mp4", 1500, "out.jpg", 448, 4);
    expect(video).toContain("-ss");
    expect(video.join(" ")).toContain("min(448,ih)");
    expect(buildAnalysisFrameArgs("in.png", null, "out.jpg", 448, 4)).not.toContain("-ss");
  });
});

describe("analyzeFrames cheap path (DEC-2026-10-02-CAPACITY-250)", () => {
  const frames = (n: number) => Array.from({ length: n }, (_, i) => ({ tMs: i * 1000, image: { width: 252, height: 448, data: new Uint8Array(252 * 448 * 3).fill(100) } }));
  const settings = (overrides: Partial<Parameters<typeof analyzeFrames>[0]["settings"]> = {}) => ({
    presetMargins: { widthPct: 30, heightPct: 10 }, textMaxFrames: 4, textTopPct: 25, textBottomPct: 60, templates: [], templateThreshold: 0.8, plan: { maxZoomPermille: 1350 }, ...overrides,
  });
  const run = (detector: FrameDetector, extra: Partial<Parameters<typeof analyzeFrames>[0]> = {}) =>
    analyzeFrames({ frames: frames(8), sourceWidth: SRC_W, sourceHeight: SRC_H, windowDurationMs: 8000, isImage: false, social: false, preferredSubject: null, detector, settings: settings(), ...extra });

  it("runs the person detector only on frames without a usable face, and OCR on at most 4 frames, top and bottom bands only", async () => {
    const { detector, counts } = fakeDetector({ faces: () => [person(80, 100, 80, 100)], persons: [person(10, 10, 100, 300)] });
    const out = await run(detector);
    expect(counts.faces).toBe(8);
    expect(counts.persons).toBe(0);
    expect(counts.text).toBe(8); // 4 frames x 2 bands
    expect(counts.textHeights.every((h) => h < 448)).toBe(true);
    expect(out.analysis.subjectSource).toBe("face");
    expect(out.analysis.framesWithFace).toBe(8);

    const noFace = fakeDetector({ persons: [person(20, 100, 180, 320)] });
    const out2 = await run(noFace.detector);
    expect(noFace.counts.persons).toBe(8);
    expect(out2.analysis.subjectSource).toBe("person");
  });

  it("turns the preset corner margins on only for social origins (zero detector calls for them)", async () => {
    const { detector } = fakeDetector({ faces: () => [person(80, 100, 80, 100)] });
    expect((await run(detector, { social: true })).analysis.presetLogoRegions).toBe(4);
    expect((await run(detector, { social: false })).analysis.presetLogoRegions).toBe(0);
  });

  it("maps text found in a band back to source pixels as an exclusion and avoids it when it can", async () => {
    // a caption at the bottom of the bottom band of every frame (frame px y ~ 400..430 of 448)
    const { detector } = fakeDetector({ faces: () => [person(90, 120, 70, 90)], text: (image) => (image.height < 448 ? [{ box: { x: 20, y: image.height - 60, w: 200, h: 24 }, score: 0.95 }] : []) });
    const out = await run(detector);
    expect(out.analysis.textRegions).toBeGreaterThanOrEqual(1);
    expect(out.cropPlan.keyframes[0]!.heightPx).toBeLessThan(SRC_H); // zoomed in to cut the caption off
    expect(out.debug.exclusions.some((e) => e.kind === "text" && e.box.yPx > SRC_H * 0.8)).toBe(true);
  });

  it("falls back to a salient region, then to a centred plan, and never invents a person", async () => {
    const blob = new Uint8Array(252 * 448 * 3).fill(40);
    for (let y = 150; y < 300; y += 1) for (let x = 60; x < 160; x += 1) blob.set([240, 60, 60], (y * 252 + x) * 3);
    const salient = await run(fakeDetector().detector, { frames: [{ tMs: 0, image: { width: 252, height: 448, data: blob } }, { tMs: 1000, image: { width: 252, height: 448, data: blob } }] });
    expect(salient.analysis.subjectSource).toBe("salient");
    expect(salient.confidence.level).toBe("low");
    const none = await run(fakeDetector().detector);
    expect(none.analysis.subjectSource).toBe("none");
    expect(none.cropPlan.primarySubjectId).toBeNull();
  });

  it("aborts with DETECTOR_TIMEOUT past the deadline and surfaces detector failures as-is", async () => {
    await expect(run(fakeDetector().detector, { deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ code: "DETECTOR_TIMEOUT" });
    const failing = fakeDetector({ failWith: new MediaJobError("MODEL_NOT_AVAILABLE", "no model") });
    await expect(run(failing.detector)).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE" });
  });
});

describe("ReframeAnalyzeProcessor", () => {
  it("returns a CropPlan + confidence for a video window, idempotently by jobKey (no re-run, reused=true)", async () => {
    await seedSource();
    const { runner, ffmpegCalls } = fakeRunner();
    const { detector, counts } = fakeDetector({ faces: () => [person(80, 100, 70, 90)] });
    const processor = processorWith(runner, detector);
    const first = await processor.handle(job({ startMs: 2000, durationMs: 9000, origin: "apify" }));
    expect(first).toMatchObject({ ok: true, reused: false, window: { startMs: 2000, durationMs: 9000 }, source: { width: SRC_W, height: SRC_H, durationMs: 20_000 } });
    if (!first.ok) throw new Error("unreachable");
    expect(first.cropPlan.targetWidthPx).toBe(1080);
    expect(first.cropPlan.durationMs).toBe(9000);
    expect(first.overlayUnavoidable).toBe(first.cropPlan.overlayUnavoidable);
    expect(first.analysis).toMatchObject({ subjectSource: "face", presetLogoRegions: 4 });
    expect(first.analysis.framesSampled).toBeGreaterThanOrEqual(6);
    expect(first.retentionClass).toBe("working");
    expect(first.tool.detectorRuntime).toBe("fake");
    expect(Math.max(...first.cropPlan.keyframes.map((k) => k.tMs))).toBeLessThanOrEqual(9000);
    const ffmpegBefore = ffmpegCalls().length;
    const detectsBefore = counts.faces;
    const second = await processor.handle(job({ startMs: 2000, durationMs: 9000, origin: "apify" }));
    expect(second).toMatchObject({ ok: true, reused: true });
    expect(ffmpegCalls().length).toBe(ffmpegBefore);
    expect(counts.faces).toBe(detectsBefore);
  });

  it("de-duplicates concurrent identical jobs, conflicts on a different input, recomputes when worker config changes", async () => {
    await seedSource();
    const { runner } = fakeRunner();
    const { detector, counts } = fakeDetector({ faces: () => [person(80, 100, 70, 90)], delayMs: 5 });
    const processor = processorWith(runner, detector);
    const [a, b] = await Promise.all([processor.handle(job()), processor.handle(job())]);
    expect(a).toBe(b);
    const facesAfterOne = counts.faces;
    expect(await processor.handle(job({ origin: "tiktok" }))).toMatchObject({ ok: false, error: { code: "JOB_KEY_CONFLICT" } });
    const reconfigured = processorWith(runner, detector, { REFRAME_MAX_ZOOM: "1.2" });
    const recomputed = await reconfigured.handle(job());
    expect(recomputed).toMatchObject({ ok: true, reused: false });
    expect(counts.faces).toBeGreaterThan(facesAfterOne);
    if (recomputed.ok) expect(recomputed.cropPlan.zoomPermille).toBeLessThanOrEqual(1200);
  });

  it("analyses a still image as one frame with a static plan", async () => {
    await seedSource();
    const { runner } = fakeRunner({ image: true });
    const { detector } = fakeDetector({ faces: () => [person(80, 100, 70, 90)] });
    const result = await processorWith(runner, detector).handle(job({ jobKey: "reframe:img", source: { relativePath: SOURCE, kind: "image" } }));
    expect(result).toMatchObject({ ok: true, window: { startMs: 0, durationMs: 0 }, cropPlan: { mode: "static" }, analysis: { framesSampled: 1 } });
  });

  it("retries a retryable FFmpeg failure (bounded) and gives up with FFMPEG_FAILED after maxAttempts", async () => {
    await seedSource();
    const flaky = fakeRunner({ failFfmpegTimes: 1 });
    const { detector } = fakeDetector({ faces: () => [person(80, 100, 70, 90)] });
    expect(await processorWith(flaky.runner, detector).handle(job({ jobKey: "reframe:flaky" }))).toMatchObject({ ok: true });
    const dead = fakeRunner({ failFfmpegTimes: 99 });
    expect(await processorWith(dead.runner, detector).handle(job({ jobKey: "reframe:dead" }))).toMatchObject({ ok: false, error: { code: "FFMPEG_FAILED", retryable: true, attempts: 2 } });
  });

  it("fails with a clear, non-retryable MODEL_NOT_AVAILABLE (no silent fallback) and rejects bad jobs and sources", async () => {
    await seedSource();
    const { runner } = fakeRunner();
    const missing = fakeDetector({ failWith: new MediaJobError("MODEL_NOT_AVAILABLE", "face_detection_yunet_2023mar.onnx is missing") });
    const result = await processorWith(runner, missing.detector).handle(job({ jobKey: "reframe:nomodel" }));
    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_NOT_AVAILABLE", retryable: false, attempts: 1 } });
    const { detector } = fakeDetector();
    const processor = processorWith(runner, detector);
    expect(await processor.handle({ jobKey: "x", type: "reframe.analyze" })).toMatchObject({ ok: false, error: { code: "INVALID_JOB" } });
    expect(await processor.handle(job({ jobKey: "reframe:nosrc", source: { relativePath: "projects/p1/assets/none.mp4" } }))).toMatchObject({ ok: false, error: { code: "SOURCE_NOT_FOUND" } });
    expect(await processor.handle(job({ jobKey: "reframe:oob", startMs: 99_000 }))).toMatchObject({ ok: false, error: { code: "RANGE_OUT_OF_BOUNDS" } });
  });

  it("caps concurrent analyses with REFRAME_CONCURRENCY", async () => {
    await seedSource();
    const { runner } = fakeRunner();
    const { detector, counts } = fakeDetector({ faces: () => [person(80, 100, 70, 90)], delayMs: 3 });
    const processor = processorWith(runner, detector, { REFRAME_CONCURRENCY: "1" });
    const results = await Promise.all([1, 2, 3].map((n) => processor.handle(job({ jobKey: `reframe:c${n}` }))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(counts.peak).toBe(1);
    const parallel = fakeDetector({ faces: () => [person(80, 100, 70, 90)], delayMs: 3 });
    const wide = processorWith(runner, parallel.detector, { REFRAME_CONCURRENCY: "3" });
    await Promise.all([1, 2, 3].map((n) => wide.handle(job({ jobKey: `reframe:w${n}` }))));
    expect(parallel.counts.peak).toBeGreaterThan(1);
  }, 30_000);

  it("keeps its working files under working/media-jobs with a 7-day expiry that the TTL sweep honours", async () => {
    await seedSource();
    const { runner } = fakeRunner();
    const { detector } = fakeDetector({ faces: () => [person(80, 100, 70, 90)] });
    const now = new Date("2026-10-02T00:00:00Z");
    const processor = new ReframeAnalyzeProcessor({ config: mediaCfg(), reframe: reframeCfg(), runner, ffmpegVersion: "t", detector, now: () => now });
    const result = await processor.handle(job({ jobKey: "reframe:ttl" }));
    if (!result.ok) throw new Error("unreachable");
    expect(result.expiresAt).toBe("2026-10-09T00:00:00.000Z");
    const manifest = JSON.parse(await readFile(join(mediaRoot, MEDIA_JOBS_DIR, jobDirName("reframe:ttl"), "result.json"), "utf8")) as { result: { expiresAt: string } };
    expect(manifest.result.expiresAt).toBe(result.expiresAt);
    expect((await sweepExpiredMediaJobs(mediaRoot, new Date("2026-10-08T00:00:00Z"))).removed).toBe(0);
    expect((await sweepExpiredMediaJobs(mediaRoot, new Date("2026-10-10T00:00:00Z"))).removed).toBe(1);
  });
});

describe("reframe.analyze over the queue", () => {
  it("is routed by the consumer and answered with the same correlationId through MediaJobClient.analyzeReframe", async () => {
    await seedSource();
    const { runner } = fakeRunner();
    const { detector } = fakeDetector({ faces: () => [person(80, 100, 70, 90)] });
    const reframeProcessor = processorWith(runner, detector);
    const broker = new InMemoryMediaJobBroker();
    const channel = broker.createChannel();
    const clipProcessor = new ClipPrepareProcessor({ config: { ...mediaCfg(), copyToleranceMs: 1000, ffmpegThreads: 1 }, runner, ffmpegVersion: "t" });
    const consumer = await startClipPrepareConsumer({ channel, queue: "lyonix.media.reframe", prefetch: 1, processor: clipProcessor, reframeProcessor });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lyonix.media.reframe" });
    const result = await client.analyzeReframe({ jobKey: "reframe:q1", source: { relativePath: SOURCE }, origin: "apify" }, { timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: true, jobKey: "reframe:q1", cropPlan: { targetWidthPx: 1080, targetHeightPx: 1920 } });
    const again = await client.analyzeReframe({ jobKey: "reframe:q1", source: { relativePath: SOURCE }, origin: "apify" }, { timeoutMs: 5000 });
    expect(again).toMatchObject({ ok: true, reused: true });
    await expect(client.analyzeReframe({ jobKey: "bad key", source: { relativePath: SOURCE } })).rejects.toMatchObject({ code: "INVALID_JOB" });
    consumer.stop();
    await consumer.drain();
  });

  it("answers INVALID_JOB (not a hang) when this worker has no reframe processor", async () => {
    const { runner } = fakeRunner();
    const broker = new InMemoryMediaJobBroker();
    const channel = broker.createChannel();
    const clipProcessor = new ClipPrepareProcessor({ config: { ...mediaCfg(), copyToleranceMs: 1000, ffmpegThreads: 1 }, runner, ffmpegVersion: "t" });
    const consumer = await startClipPrepareConsumer({ channel, queue: "lyonix.media.noreframe", prefetch: 1, processor: clipProcessor });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lyonix.media.noreframe" });
    expect(await client.analyzeReframe({ jobKey: "reframe:q2", source: { relativePath: SOURCE } }, { timeoutMs: 2000 })).toMatchObject({ ok: false, error: { code: "INVALID_JOB" } });
    consumer.stop();
    await consumer.drain();
  });
});
