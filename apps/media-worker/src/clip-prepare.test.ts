import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClipPrepareJob, MediaJobClient, type ClipPrepareJob } from "@lyonix/media-jobs";
import { InMemoryMediaJobBroker } from "@lyonix/media-jobs/testing";
import { ClipPrepareProcessor, jobDirName, MEDIA_JOBS_DIR } from "./clip-prepare.js";
import { loadMediaWorkerConfig, MediaWorkerConfigError } from "./config.js";
import { startClipPrepareConsumer } from "./consumer.js";
import { ProcessTimeoutError, type ProcessRunner } from "./process.js";
import { sweepExpiredMediaJobs } from "./ttl-sweep.js";

const SOURCE = "projects/p1/assets/source.mp4";

type FakeOptions = {
  source?: Record<string, unknown>;
  output?: Record<string, unknown>;
  keyframesCsv?: string;
  ffmpegFailures?: number;
  ffmpegTimeouts?: number;
};

const streamsJson = (video: Record<string, unknown>, audio: string | null, duration: number) =>
  JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", avg_frame_rate: "30/1", ...video },
      ...(audio ? [{ codec_type: "audio", codec_name: audio }] : []),
    ],
    format: { format_name: "mov,mp4", duration: String(duration), start_time: "0" },
  });

/** Deterministic stand-in for ffmpeg/ffprobe (unit tests only; the real binary is exercised in ffmpeg.integration.test.ts). */
const fakeRunner = (options: FakeOptions = {}) => {
  const calls: Array<{ binary: string; args: readonly string[] }> = [];
  let failures = options.ffmpegFailures ?? 0;
  let timeouts = options.ffmpegTimeouts ?? 0;
  const runner: ProcessRunner = async (binary, args) => {
    calls.push({ binary, args });
    const last = args[args.length - 1]!;
    if (binary === "ffprobe" && args.includes("-show_entries")) {
      return { exitCode: 0, stdout: options.keyframesCsv ?? "0.000000,K__\n2.000000,K__\n4.000000,K__\n", stderrTail: "" };
    }
    if (binary === "ffprobe") {
      if (last.endsWith(".partial")) {
        const out = (options.output ?? {}) as { video?: Record<string, unknown>; audio?: string | null; duration?: number };
        const stripped = calls.some((c) => c.binary === "ffmpeg" && c.args.includes("-an"));
        return { exitCode: 0, stdout: streamsJson(out.video ?? {}, out.audio !== undefined ? out.audio : stripped ? null : "aac", out.duration ?? 5), stderrTail: "" };
      }
      const src = (options.source ?? {}) as { video?: Record<string, unknown>; audio?: string | null; duration?: number };
      return { exitCode: 0, stdout: streamsJson(src.video ?? {}, src.audio !== undefined ? src.audio : "aac", src.duration ?? 30), stderrTail: "" };
    }
    if (timeouts > 0) {
      timeouts -= 1;
      throw new ProcessTimeoutError(binary, 10);
    }
    if (failures > 0) {
      failures -= 1;
      return { exitCode: 1, stdout: "", stderrTail: "Conversion failed!" };
    }
    await writeFile(last, Buffer.from(`fake-mp4:${args.join(" ")}`));
    return { exitCode: 0, stdout: "", stderrTail: "" };
  };
  return { runner, calls, ffmpegCalls: () => calls.filter((c) => c.binary === "ffmpeg") };
};

let mediaRoot: string;
const cfg = () => ({ mediaRoot, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", copyToleranceMs: 1000, jobTimeoutMs: 5000, maxAttempts: 2 });
const job = (overrides: Partial<ClipPrepareJob> = {}): ClipPrepareJob => ({
  ...buildClipPrepareJob({ jobKey: "clip:test-1", source: { relativePath: SOURCE, mediaAssetVersionId: "mav-1" }, startMs: 2100, durationMs: 5000, stripAudio: true }),
  ...overrides,
});

beforeEach(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), "lyonix-media-worker-"));
  await mkdir(join(mediaRoot, "projects/p1/assets"), { recursive: true });
  await writeFile(join(mediaRoot, SOURCE), "source-bytes");
  await mkdir(join(mediaRoot, "_quarantine"), { recursive: true });
  await writeFile(join(mediaRoot, "_quarantine", "q.mp4"), "q");
});

afterEach(async () => {
  await rm(mediaRoot, { recursive: true, force: true });
});

describe("ClipPrepareProcessor", () => {
  it("copies an eligible source, writes a working-class output with checksum + metadata", async () => {
    const fake = fakeRunner();
    const now = new Date("2026-09-29T00:00:00.000Z");
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "ffmpeg version test", now: () => now });
    const result = await processor.handle(job());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("copy");
    expect(result.cut).toEqual({ startMs: 2000, durationMs: 5000 });
    expect(result.drift.startMs).toBe(-100);
    expect(result.output.relativePath).toBe(`${MEDIA_JOBS_DIR}/${jobDirName("clip:test-1")}/clip.mp4`);
    expect(result.output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.output).toMatchObject({ retentionClass: "working", hasAudio: false, videoCodec: "h264", width: 1080, height: 1920, expiresAt: "2026-10-06T00:00:00.000Z" });
    expect(result.source).toMatchObject({ mediaAssetVersionId: "mav-1", videoCodec: "h264", audioCodec: "aac" });
    expect(fake.ffmpegCalls()[0]!.args).toEqual(expect.arrayContaining(["-c", "copy", "-an"]));
  });

  it("re-encodes when the source is above 1080p", async () => {
    const fake = fakeRunner({ source: { video: { width: 3840, height: 2160 } } });
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const result = await processor.handle(job());
    expect(result.ok && result.mode).toBe("reencode");
    expect(result.ok && result.reencodeReasons).toContain("resolution_above_1080p");
    expect(fake.ffmpegCalls()[0]!.args).toContain("libx264");
  });

  it("falls back to re-encode when a copy output misses the duration tolerance", async () => {
    const outputs = [8, 5];
    const fake = fakeRunner();
    const runner: ProcessRunner = async (binary, args, opts) => {
      if (binary === "ffprobe" && !args.includes("-show_entries") && args[args.length - 1]!.endsWith(".partial")) {
        return { exitCode: 0, stdout: streamsJson({}, null, outputs.shift() ?? 5), stderrTail: "" };
      }
      return fake.runner(binary, args, opts);
    };
    const processor = new ClipPrepareProcessor({ config: cfg(), runner, ffmpegVersion: "v" });
    const result = await processor.handle(job());
    expect(result.ok && result.mode).toBe("reencode");
    expect(result.ok && result.reencodeReasons).toEqual(["copy_output_duration_drift"]);
    expect(fake.ffmpegCalls()).toHaveLength(2);
  });

  it("is idempotent by jobKey: re-delivery returns the stored result without running ffmpeg again", async () => {
    const fake = fakeRunner();
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const first = await processor.handle(job());
    const second = await processor.handle(job());
    const fresh = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const third = await fresh.handle(job());
    expect(fake.ffmpegCalls()).toHaveLength(1);
    expect(first.ok && first.reused).toBe(false);
    expect(second.ok && second.reused).toBe(true);
    expect(third.ok && third.reused).toBe(true);
    expect(second.ok && first.ok && second.output.sha256 === first.output.sha256).toBe(true);
  });

  it("dedupes concurrent deliveries of the same jobKey in-process", async () => {
    const fake = fakeRunner();
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const [a, b] = await Promise.all([processor.handle(job()), processor.handle(job())]);
    expect(fake.ffmpegCalls()).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("re-runs when the stored output was removed or tampered with", async () => {
    const fake = fakeRunner();
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const first = await processor.handle(job());
    if (!first.ok) throw new Error("expected ok");
    await writeFile(join(mediaRoot, first.output.relativePath), "tampered-bytes-of-some-length");
    const second = await processor.handle(job());
    expect(second.ok && second.reused).toBe(false);
    expect(fake.ffmpegCalls()).toHaveLength(2);
  });

  it("returns JOB_KEY_CONFLICT when a key is reused for different input", async () => {
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fakeRunner().runner, ffmpegVersion: "v" });
    await processor.handle(job());
    const conflict = await processor.handle(job({ startMs: 0 }));
    expect(conflict).toMatchObject({ ok: false, error: { code: "JOB_KEY_CONFLICT", retryable: false } });
  });

  it.each([
    ["quarantine", "_quarantine/q.mp4", "SOURCE_UNSAFE_PATH"],
    ["missing", "projects/p1/assets/missing.mp4", "SOURCE_NOT_FOUND"],
  ])("rejects %s sources", async (_label, relativePath, code) => {
    const fake = fakeRunner();
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const result = await processor.handle(job({ source: { relativePath, mediaAssetVersionId: null } }));
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(fake.calls).toHaveLength(0);
  });

  it("returns INVALID_JOB for traversal paths without touching the filesystem", async () => {
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fakeRunner().runner, ffmpegVersion: "v" });
    const result = await processor.handle({ ...job(), source: { relativePath: "../../etc/passwd" } });
    expect(result).toMatchObject({ ok: false, jobKey: "clip:test-1", error: { code: "INVALID_JOB" } });
  });

  it("returns RANGE_OUT_OF_BOUNDS when the range runs past the source by more than tolerance", async () => {
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fakeRunner({ source: { duration: 6 } }).runner, ffmpegVersion: "v" });
    const result = await processor.handle(job({ startMs: 2000, durationMs: 5500 })); // 1500ms past the 6s source
    expect(result).toMatchObject({ ok: false, error: { code: "RANGE_OUT_OF_BOUNDS", retryable: false } });
  });

  it("returns NO_VIDEO_STREAM for audio-only sources", async () => {
    const runner: ProcessRunner = async () => ({ exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }], format: { duration: "5" } }), stderrTail: "" });
    const processor = new ClipPrepareProcessor({ config: cfg(), runner, ffmpegVersion: "v" });
    expect(await processor.handle(job())).toMatchObject({ ok: false, error: { code: "NO_VIDEO_STREAM" } });
  });

  it("retries a failing ffmpeg run up to maxAttempts, then reports FFMPEG_FAILED with the attempt count", async () => {
    const recovering = fakeRunner({ ffmpegFailures: 1 });
    const ok = await new ClipPrepareProcessor({ config: cfg(), runner: recovering.runner, ffmpegVersion: "v" }).handle(job());
    expect(ok.ok).toBe(true);
    expect(recovering.ffmpegCalls()).toHaveLength(2);

    const broken = fakeRunner({ ffmpegFailures: 99 });
    const failed = await new ClipPrepareProcessor({ config: cfg(), runner: broken.runner, ffmpegVersion: "v" }).handle(job({ jobKey: "clip:test-2" }));
    expect(failed).toMatchObject({ ok: false, error: { code: "FFMPEG_FAILED", retryable: true, attempts: 2 } });
    expect(broken.ffmpegCalls()).toHaveLength(2);
    const dir = join(mediaRoot, MEDIA_JOBS_DIR, jobDirName("clip:test-2"));
    expect(await readdir(dir)).toEqual([]); // no partial output or lock left behind
  });

  it("maps a killed (timed-out) ffmpeg to FFMPEG_TIMEOUT", async () => {
    const fake = fakeRunner({ ffmpegTimeouts: 99 });
    const result = await new ClipPrepareProcessor({ config: { ...cfg(), maxAttempts: 1 }, runner: fake.runner, ffmpegVersion: "v" }).handle(job());
    expect(result).toMatchObject({ ok: false, error: { code: "FFMPEG_TIMEOUT", attempts: 1 } });
  });

  it("fails OUTPUT_INVALID if stripAudio was requested but the output still has audio", async () => {
    const fake = fakeRunner({ output: { audio: "aac" } });
    const result = await new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" }).handle(job());
    expect(result).toMatchObject({ ok: false, error: { code: "OUTPUT_INVALID" } });
  });
});

describe("clip.prepare consumer + MediaJobClient (in-memory broker)", () => {
  it("round-trips a job: client enqueue -> worker -> result with correlationId; re-send is reused", async () => {
    const broker = new InMemoryMediaJobBroker();
    const fake = fakeRunner();
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const workerChannel = broker.createChannel();
    const consumer = await startClipPrepareConsumer({ channel: workerChannel, queue: "q", prefetch: 1, processor });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q" });
    const first = await client.prepareClip(job(), { timeoutMs: 2000 });
    const second = await client.prepareClip(job(), { timeoutMs: 2000 });
    expect(first).toMatchObject({ ok: true, reused: false, mode: "copy" });
    expect(second).toMatchObject({ ok: true, reused: true });
    expect(fake.ffmpegCalls()).toHaveLength(1);
    await consumer.drain();
    expect(broker.depth("q")).toBe(0);
  });

  it("VE2E-61: prefetch>1 runs jobs in parallel with independent outputs; a duplicate jobKey is still processed once", async () => {
    const broker = new InMemoryMediaJobBroker();
    const base = fakeRunner();
    let active = 0;
    let peak = 0;
    const runner: ProcessRunner = async (binary, args, opts) => {
      if (binary !== "ffmpeg") return base.runner(binary, args, opts);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 25));
      active -= 1;
      return base.runner(binary, args, opts);
    };
    const processor = new ClipPrepareProcessor({ config: { ...cfg(), ffmpegThreads: 2 }, runner, ffmpegVersion: "v" });
    await startClipPrepareConsumer({ channel: broker.createChannel(), queue: "q", prefetch: 3, processor });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q" });
    const jobs = [1, 2, 3].map((n) => job({ ...buildClipPrepareJob({ jobKey: `clip:par-${n}`, source: { relativePath: SOURCE, mediaAssetVersionId: "mav-1" }, startMs: 2000 + n * 100, durationMs: 4000, stripAudio: true }) }));
    const results = await Promise.all([...jobs, jobs[0]!].map((j) => client.prepareClip(j, { timeoutMs: 3000 })));
    expect(results.every((r) => r.ok)).toBe(true);
    const keys = results.slice(0, 3).map((r) => r.jobKey);
    expect(new Set(keys).size).toBe(3);
    const paths = results.slice(0, 3).map((r) => (r.ok ? r.output.relativePath : ""));
    expect(new Set(paths).size).toBe(3);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    // 3 distinct jobKeys -> 3 ffmpeg runs; the 4th message (same jobKey as the first) is either locked-and-requeued or reused, never re-encoded.
    expect(base.ffmpegCalls()).toHaveLength(3);
    for (const call of base.ffmpegCalls()) {
      const idx = call.args.indexOf("-threads");
      expect(idx).toBeGreaterThan(-1);
      expect(call.args[idx + 1]).toBe("2");
      expect(idx).toBe(call.args.length - 3); // output option, right before the output path
    }
  });

  it("answers poison messages with INVALID_JOB and acks them", async () => {
    const broker = new InMemoryMediaJobBroker();
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fakeRunner().runner, ffmpegVersion: "v" });
    await startClipPrepareConsumer({ channel: broker.createChannel(), queue: "q", prefetch: 1, processor });
    const producer = broker.createChannel();
    const reply = await producer.assertQueue("");
    const replies: string[] = [];
    await producer.consume(reply.queue, (m) => { if (m) replies.push(`${m.properties.correlationId}:${m.content.toString()}`); }, { noAck: true });
    producer.sendToQueue("q", Buffer.from("{not json"), { replyTo: reply.queue, correlationId: "c1", messageId: "k1" });
    producer.sendToQueue("q", Buffer.from(JSON.stringify({ type: "frame.extract" })), { replyTo: reply.queue, correlationId: "c2" });
    await new Promise((r) => setTimeout(r, 20));
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatch(/^c1:.*"INVALID_JOB"/);
    expect(replies[1]).toMatch(/^c2:.*unsupported media job type/);
    expect(broker.depth("q")).toBe(0);
  });

  it("requeues when another process holds the job lock", async () => {
    const broker = new InMemoryMediaJobBroker();
    const fake = fakeRunner();
    const processor = new ClipPrepareProcessor({ config: cfg(), runner: fake.runner, ffmpegVersion: "v" });
    const lockDir = join(mediaRoot, MEDIA_JOBS_DIR, jobDirName("clip:test-1"));
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, ".lock"), "other-pid");
    await startClipPrepareConsumer({ channel: broker.createChannel(), queue: "q", prefetch: 1, processor, lockRetryDelayMs: 5 });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q" });
    const pending = client.prepareClip(job(), { timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.ffmpegCalls()).toHaveLength(0);
    await rm(join(lockDir, ".lock"));
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});

describe("sweepExpiredMediaJobs (7-day working TTL)", () => {
  it("removes expired and stale manifest-less job dirs only", async () => {
    const root = join(mediaRoot, MEDIA_JOBS_DIR);
    const mk = async (name: string, expiresAt?: string) => {
      await mkdir(join(root, name), { recursive: true });
      if (expiresAt) await writeFile(join(root, name, "result.json"), JSON.stringify({ result: { output: { expiresAt } } }));
    };
    const now = new Date("2026-10-10T00:00:00Z");
    await mk("expired", "2026-10-01T00:00:00Z");
    await mk("fresh", "2026-10-12T00:00:00Z");
    await mk("orphan-old");
    await utimes(join(root, "orphan-old"), new Date("2026-09-01"), new Date("2026-09-01"));
    await mk("orphan-new");
    await utimes(join(root, "orphan-new"), now, now);
    const { removed } = await sweepExpiredMediaJobs(mediaRoot, now);
    expect(removed).toBe(2);
    expect((await readdir(root)).sort()).toEqual(["fresh", "orphan-new"]);
    expect(await readdir(join(mediaRoot, "projects/p1/assets"))).toEqual(["source.mp4"]);
  });
});

describe("loadMediaWorkerConfig", () => {
  it("defaults: queue lyonix.media, tolerance 1000ms, bounded timeout/attempts, repo-relative MEDIA_ROOT", () => {
    const config = loadMediaWorkerConfig({}, "/repo", 8);
    expect(config).toMatchObject({ queue: "lyonix.media", copyToleranceMs: 1000, jobTimeoutMs: 120_000, maxAttempts: 2, prefetch: 3, ffmpegThreads: 2, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", rabbitmqUrl: null });
    expect(config.mediaRoot.replaceAll("\\", "/")).toMatch(/\/repo\/data\/media$/);
  });

  it("VE2E-61: prefetch defaults to 3 but never exceeds the CPU count; FFmpeg threads share the CPUs", () => {
    expect(loadMediaWorkerConfig({}, "/repo", 2)).toMatchObject({ prefetch: 2, ffmpegThreads: 1 });
    expect(loadMediaWorkerConfig({}, "/repo", 1)).toMatchObject({ prefetch: 1, ffmpegThreads: 1 });
    expect(loadMediaWorkerConfig({}, "/repo", 12)).toMatchObject({ prefetch: 3, ffmpegThreads: 4 });
    expect(loadMediaWorkerConfig({ MEDIA_WORKER_PREFETCH: "8" }, "/repo", 4)).toMatchObject({ prefetch: 4, ffmpegThreads: 1 });
    expect(loadMediaWorkerConfig({ MEDIA_WORKER_PREFETCH: "2", MEDIA_WORKER_FFMPEG_THREADS: "6" }, "/repo", 16)).toMatchObject({ prefetch: 2, ffmpegThreads: 6 });
    expect(() => loadMediaWorkerConfig({ MEDIA_WORKER_PREFETCH: "0" }, "/repo", 4)).toThrow(MediaWorkerConfigError);
    expect(() => loadMediaWorkerConfig({ MEDIA_WORKER_FFMPEG_THREADS: "x" }, "/repo", 4)).toThrow(MediaWorkerConfigError);
  });

  it("reads overrides and rejects out-of-range values", () => {
    const config = loadMediaWorkerConfig({ MEDIA_WORKER_COPY_TOLERANCE_MS: "500", FFMPEG_PATH: "/opt/ffmpeg", MEDIA_WORKER_QUEUE: "custom", RABBITMQ_URL: "amqp://x" }, "/repo");
    expect(config).toMatchObject({ copyToleranceMs: 500, ffmpegPath: "/opt/ffmpeg", queue: "custom", rabbitmqUrl: "amqp://x" });
    expect(() => loadMediaWorkerConfig({ MEDIA_WORKER_MAX_ATTEMPTS: "50" }, "/repo")).toThrow(MediaWorkerConfigError);
    expect(() => loadMediaWorkerConfig({ MEDIA_WORKER_COPY_TOLERANCE_MS: "abc" }, "/repo")).toThrow(MediaWorkerConfigError);
  });
});
