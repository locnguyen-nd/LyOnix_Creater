import { describe, expect, it } from "vitest";
import { MediaJobClient } from "./client.js";
import {
  buildComposeJobKey,
  buildVideoComposeJob,
  canonicalJson,
  COMPOSE_PROFILE_VERSION,
  composeFingerprint,
  DEFAULT_RENDER_QUEUE,
  isComposeInputError,
  parseVideoComposeProgress,
  parseVideoComposeResult,
  validateVideoComposeJob,
  VIDEO_COMPOSE_PROGRESS_TYPE,
  VIDEO_COMPOSE_RESULT_TYPE,
  type ComposePlan,
  type VideoComposeJob,
  type VideoComposeResult,
} from "./compose-contract.js";
import { MEDIA_JOB_SCHEMA_VERSION } from "./contract.js";
import { InMemoryMediaJobBroker } from "./testing.js";

const scene = (id: string, startFrame: number, durationFrames = 180) => ({
  sceneId: id,
  startFrame,
  durationFrames,
  media: { relativePath: `working/media-jobs/${id}/clip.mp4`, mediaAssetVersionId: `mav-${id}`, kind: "video" as const, sourceStartMs: null, sourceDurationMs: null },
  voice: { relativePath: `projects/p/audio/${id}.mp3`, durationMs: 3000 },
  text: "テロップ",
  captionCues: [{ text: "字幕", startMs: 0, endMs: 1000 }],
  effectIn: { kind: "none" as const },
  effectOut: { kind: "none" as const },
  transitionIn: { kind: "none" as const, durationMs: 0 },
});

const plan = (): ComposePlan => ({
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  padStartFrames: 30,
  padEndFrames: 60,
  totalFrames: 30 + 180 * 3 + 60,
  scenes: [scene("a", 30), scene("b", 210), scene("c", 390)],
  music: null,
  params: { accent: "#ff0000" },
});

const job = (over: Partial<VideoComposeJob> = {}): VideoComposeJob => ({
  ...buildVideoComposeJob({ jobKey: "compose:x", recipe: { id: "news-recap-broadcast-telop-jp", version: 1 }, plan: plan() }),
  ...over,
});

describe("validateVideoComposeJob (VE2E-104)", () => {
  it("accepts a well-formed job and normalises backslashes", () => {
    const input = job();
    input.plan.scenes[0]!.media.relativePath = "working\\media-jobs\\a\\clip.mp4";
    const result = validateVideoComposeJob(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.plan.scenes[0]!.media.relativePath).toBe("working/media-jobs/a/clip.mp4");
  });

  it("rejects anything but 1080x1920 at 60 fps (hard requirement)", () => {
    const bad30 = job();
    bad30.plan.fps = 30;
    expect(validateVideoComposeJob(bad30)).toMatchObject({ ok: false });
    const badSize = job();
    badSize.plan.canvas = { width: 720, height: 1280 };
    expect(validateVideoComposeJob(badSize)).toMatchObject({ ok: false });
  });

  it("rejects unsafe paths, gaps between scenes, wrong totals, bad cues and bad recipes", () => {
    const unsafe = job();
    unsafe.plan.scenes[1]!.voice.relativePath = "../etc/passwd";
    expect(validateVideoComposeJob(unsafe)).toMatchObject({ ok: false });

    const gap = job();
    gap.plan.scenes[1]!.startFrame += 5;
    expect(validateVideoComposeJob(gap)).toMatchObject({ ok: false });

    const total = job();
    total.plan.totalFrames += 1;
    expect(validateVideoComposeJob(total)).toMatchObject({ ok: false });

    const cue = job();
    cue.plan.scenes[0]!.captionCues = [{ text: "x", startMs: 500, endMs: 100 }];
    expect(validateVideoComposeJob(cue)).toMatchObject({ ok: false });

    const timings = job();
    timings.plan.scenes[0]!.captionCues = [{ text: "ab", startMs: 0, endMs: 100, charTimings: [{ startMs: 0, endMs: 50 }] }];
    expect(validateVideoComposeJob(timings)).toMatchObject({ ok: false });

    expect(validateVideoComposeJob(job({ recipe: { id: "Bad Id", version: 1 } }))).toMatchObject({ ok: false });
    expect(validateVideoComposeJob(job({ jobKey: "bad key!" }))).toMatchObject({ ok: false });
    expect(validateVideoComposeJob({ ...job(), plan: { ...plan(), scenes: [] } })).toMatchObject({ ok: false });
  });
});

describe("fingerprint and job key", () => {
  it("is independent of key order and jobKey, and sensitive to plan, recipe and file hashes", () => {
    const a = job();
    const reordered = { recipe: { version: 1, id: "news-recap-broadcast-telop-jp" }, plan: JSON.parse(JSON.stringify(a.plan)) } as Pick<VideoComposeJob, "recipe" | "plan">;
    expect(composeFingerprint(reordered)).toBe(composeFingerprint(a));
    expect(composeFingerprint({ ...a, jobKey: "different" } as VideoComposeJob)).toBe(composeFingerprint(a));
    expect(buildComposeJobKey(a)).toMatch(/^compose:[0-9a-f]{40}$/);

    const otherText = job();
    otherText.plan.scenes[0]!.text = "別のテロップ";
    expect(composeFingerprint(otherText)).not.toBe(composeFingerprint(a));
    expect(composeFingerprint(job({ recipe: { id: "news-recap-broadcast-telop-jp", version: 2 } }))).not.toBe(composeFingerprint(a));
    const hashed = job();
    hashed.plan.scenes[0]!.media.sha256 = "a".repeat(64);
    expect(composeFingerprint(hashed)).not.toBe(composeFingerprint(a));
    expect(COMPOSE_PROFILE_VERSION).toBe("compose.v1");
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });
});

describe("result parsing", () => {
  const qc = { passed: true, checks: [], measured: {} };
  it("accepts success/failure results with known codes and rejects unknown shapes", () => {
    const ok = { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_RESULT_TYPE, ok: true, jobKey: "k", output: { relativePath: "working/renders/k/video.mp4", sha256: "s" }, thumbnail: { relativePath: "t.jpg" }, qc };
    expect(parseVideoComposeResult(ok)).not.toBeNull();
    const failure = { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_RESULT_TYPE, ok: false, jobKey: "k", error: { code: "QC_LOUDNESS", message: "m", retryable: false, attempts: 1 } };
    expect(parseVideoComposeResult(failure)).not.toBeNull();
    expect(parseVideoComposeResult({ ...failure, error: { ...failure.error, code: "NOPE" } })).toBeNull();
    expect(parseVideoComposeResult({ ...ok, qc: undefined })).toBeNull();
    expect(parseVideoComposeResult({ ...ok, type: "clip.prepare.result" })).toBeNull();
  });

  it("input errors are exactly the ones a paid fallback cannot fix", () => {
    for (const code of ["INVALID_JOB", "SOURCE_NOT_FOUND", "SOURCE_UNSAFE_PATH", "NO_VIDEO_STREAM", "RANGE_OUT_OF_BOUNDS", "JOB_KEY_CONFLICT"]) expect(isComposeInputError(code)).toBe(true);
    for (const code of ["FFMPEG_FAILED", "FFMPEG_TIMEOUT", "QC_DURATION", "QC_LOUDNESS", "FONT_MISSING", "RECIPE_NOT_FOUND", "INTERNAL"]) expect(isComposeInputError(code)).toBe(false);
  });
});

describe("MediaJobClient.composeVideo", () => {
  const startWorker = async (broker: InMemoryMediaJobBroker, handler: (job: VideoComposeJob, send: (type: string, body: unknown) => void) => void) => {
    const channel = broker.createChannel();
    await channel.assertQueue(DEFAULT_RENDER_QUEUE);
    await channel.consume(DEFAULT_RENDER_QUEUE, (message) => {
      if (!message) return;
      const parsed = JSON.parse(message.content.toString()) as VideoComposeJob;
      const send = (type: string, body: unknown) =>
        channel.sendToQueue(message.properties.replyTo!, Buffer.from(JSON.stringify(body)), { type, ...(message.properties.correlationId ? { correlationId: message.properties.correlationId } : {}) });
      handler(parsed, send);
      channel.ack(message);
    });
  };
  const success = (jobKey: string): VideoComposeResult => ({
    schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
    type: VIDEO_COMPOSE_RESULT_TYPE,
    ok: true,
    jobKey,
    reused: false,
    output: { relativePath: `working/renders/${jobKey}/video.mp4`, mimeType: "video/mp4", sha256: "s", bytes: 1, durationMs: 1000, width: 1080, height: 1920, fps: 60 },
    thumbnail: { relativePath: `working/renders/${jobKey}/thumb.jpg`, mimeType: "image/jpeg", sha256: "t", bytes: 1, width: 1080, height: 1920 },
    qc: { passed: true, checks: [], measured: { width: 1080, height: 1920, fps: 60, videoCodec: "h264", profile: "High", pixFmt: "yuv420p", durationMs: 1000, audioCodec: "aac", sampleRate: 48000, channels: 2, integratedLufs: -14, truePeakDbtp: -1.5, blackMs: 0, freezeMs: 0 } },
    metrics: { renderMs: 10, cpuSeconds: null, x264Preset: "faster", x264Threads: 2 },
    retentionClass: "working",
    expiresAt: new Date(0).toISOString(),
    tool: { profileVersion: COMPOSE_PROFILE_VERSION, ffmpegVersion: "test", recipe: { id: "r", version: 1 } },
    completedAt: new Date(0).toISOString(),
  });

  it("sends the job to lyonix.render (not the media queue), streams progress and resolves with the result", async () => {
    const broker = new InMemoryMediaJobBroker();
    await startWorker(broker, (received, send) => {
      send(VIDEO_COMPOSE_PROGRESS_TYPE, { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_PROGRESS_TYPE, jobKey: received.jobKey, stage: "encoding", percent: 40, frame: 100, totalFrames: 250, speedX: 1.1 });
      send(VIDEO_COMPOSE_PROGRESS_TYPE, { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_PROGRESS_TYPE, jobKey: "someone-else", stage: "encoding", percent: 99, frame: null, totalFrames: null, speedX: null });
      send(VIDEO_COMPOSE_RESULT_TYPE, success(received.jobKey));
    });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lyonix.media.test" });
    const progress: number[] = [];
    const result = await client.composeVideo(job(), { timeoutMs: 1000, onProgress: (p) => progress.push(p.percent) });
    expect(result.ok).toBe(true);
    expect(progress).toEqual([40]);
    expect(broker.published.filter((p) => p.queue === DEFAULT_RENDER_QUEUE)).toHaveLength(1);
    expect(broker.published.filter((p) => p.queue === "lyonix.media.test")).toHaveLength(0);
    expect(client.inFlight).toBe(0);
  });

  it("restarts the idle timeout on every progress message and times out when the worker goes silent", async () => {
    const broker = new InMemoryMediaJobBroker();
    await startWorker(broker, (received, send) => {
      const tick = (percent: number) =>
        send(VIDEO_COMPOSE_PROGRESS_TYPE, { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_PROGRESS_TYPE, jobKey: received.jobKey, stage: "encoding", percent, frame: null, totalFrames: null, speedX: null });
      setTimeout(() => tick(10), 40);
      setTimeout(() => tick(20), 80);
      setTimeout(() => send(VIDEO_COMPOSE_RESULT_TYPE, success(received.jobKey)), 120);
    });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lyonix.media.test" });
    // total 120 ms > timeout 70 ms, yet progress every 40 ms keeps it alive
    await expect(client.composeVideo(job(), { timeoutMs: 70 })).resolves.toMatchObject({ ok: true });

    const silent = new InMemoryMediaJobBroker();
    await startWorker(silent, () => undefined);
    const client2 = await MediaJobClient.create({ channel: silent.createChannel(), queue: "lyonix.media.test" });
    await expect(client2.composeVideo(job(), { timeoutMs: 30 })).rejects.toMatchObject({ code: "RESULT_TIMEOUT" });
    expect(client2.inFlight).toBe(0);
  });

  it("rejects an invalid job before touching the broker", async () => {
    const broker = new InMemoryMediaJobBroker();
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lyonix.media.test" });
    const bad = job();
    bad.plan.fps = 30;
    await expect(client.composeVideo(bad)).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(broker.published).toHaveLength(0);
  });

  it("parses progress messages strictly", () => {
    expect(parseVideoComposeProgress({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_PROGRESS_TYPE, jobKey: "k", percent: 5 })).not.toBeNull();
    expect(parseVideoComposeProgress({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: "other", jobKey: "k", percent: 5 })).toBeNull();
  });
});
