import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDIA_JOB_SCHEMA_VERSION, VIDEO_COMPOSE_JOB_TYPE, VIDEO_COMPOSE_PROGRESS_TYPE, VIDEO_COMPOSE_RESULT_TYPE, parseVideoComposeProgress, parseVideoComposeResult } from "@lyonix/media-jobs";
import { InMemoryMediaJobBroker } from "@lyonix/media-jobs/testing";
import { JobLockBusyError } from "../job-errors.js";
import { runProcess } from "../process.js";
import type { ComposeProcessor } from "./compose-processor.js";
import { ComposeConfigError, loadComposeConfig } from "./config.js";
import { startComposeConsumer } from "./consumer.js";
import { acquireJobLock } from "./job-lock.js";
import { buildOverlayDocuments, captionCuesFromComposePlan } from "./overlays.js";
import { FfmpegProgressParser, progressPercent } from "./progress.js";
import { makePlan, testRecipe } from "./test-fixtures.js";

describe("loadComposeConfig", () => {
  it("has safe defaults for a laptop-class machine", () => {
    const cfg = loadComposeConfig({}, "/repo", 8);
    expect(cfg).toMatchObject({ queue: "lyonix.render", prefetch: 1, x264Preset: "faster", x264Threads: 0, fontsDir: null, timeoutMs: 15 * 60_000 });
  });
  it("reads env, resolves the fonts dir against the repo root and never exceeds the CPU count for prefetch", () => {
    const cfg = loadComposeConfig({ MEDIA_WORKER_RENDER_PREFETCH: "4", RENDER_X264_PRESET: "veryfast", RENDER_X264_THREADS: "6", RENDER_FONTS_DIR: "data/fonts", MEDIA_WORKER_RENDER_QUEUE: "r.q" }, "/repo", 2);
    expect(cfg).toMatchObject({ prefetch: 2, x264Preset: "veryfast", x264Threads: 6, queue: "r.q" });
    expect(cfg.fontsDir?.replaceAll("\\", "/")).toMatch(/\/repo\/data\/fonts$|repo[\\/]data[\\/]fonts$/);
  });
  it("rejects invalid values with a clear message", () => {
    expect(() => loadComposeConfig({ RENDER_X264_PRESET: "turbo" }, "/r")).toThrow(ComposeConfigError);
    expect(() => loadComposeConfig({ RENDER_X264_THREADS: "-1" }, "/r")).toThrow(/RENDER_X264_THREADS/);
    expect(() => loadComposeConfig({ RENDER_JOB_TIMEOUT_MS: "5" }, "/r")).toThrow(/RENDER_JOB_TIMEOUT_MS/);
  });
});

describe("ffmpeg progress", () => {
  it("emits a snapshot at the end of each progress block with frame and speed", () => {
    const parser = new FfmpegProgressParser();
    const out = ["frame=120", "fps=55.1", "out_time_us=2000000", "speed=1.07x", "progress=continue", "frame=240", "speed=N/A", "progress=end"].map((line) => parser.push(line));
    expect(out.filter(Boolean)).toEqual([
      { frame: 120, speedX: 1.07, ended: false },
      { frame: 240, speedX: null, ended: true },
    ]);
    expect(parser.push("garbage")).toBeNull();
  });
  it("maps stages onto a monotonic 0..100 scale", () => {
    const values = [progressPercent("preparing", null, 600), progressPercent("encoding", 0, 600), progressPercent("encoding", 300, 600), progressPercent("encoding", 600, 600), progressPercent("qc", 600, 600), progressPercent("finalizing", 600, 600)];
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values.at(-1)).toBeLessThanOrEqual(100);
    expect(progressPercent("encoding", 99999, 600)).toBeLessThanOrEqual(94);
  });
});

describe("overlays", () => {
  const files = { image: "i.jpg", landscape: "l.mp4", portraitShort: "p.mp4", voices: ["v0.mp3", "v1.mp3", "v2.mp3"], music: "m.wav" };
  it("builds caption cues on the absolute timeline from voice-timed cues or the static scene text", () => {
    const plan = makePlan(files, { texts: ["一つ目", "二つ目", "三つ目"] });
    plan.scenes[1]!.captionCues = [{ text: "二つ目", startMs: 100, endMs: 900 }];
    const cues = captionCuesFromComposePlan(plan);
    expect(cues).toHaveLength(3);
    expect(cues[1]!.startMs).toBeCloseTo((plan.scenes[1]!.startFrame * 1000) / 60 + 100, 3);
    expect(cues[0]!.startMs).toBeCloseTo((plan.scenes[0]!.startFrame * 1000) / 60, 3);
  });
  it("renders the headline layer centred in its rectangle only when the slot has a value, and honours Studio caption overrides", () => {
    const plan = makePlan(files, { texts: ["一つ目", "二つ目", "三つ目"] });
    const recipe = testRecipe("Noto Sans JP");
    const empty = buildOverlayDocuments(plan, recipe, {});
    expect(empty.layers).toEqual([]);
    const withHeadline = buildOverlayDocuments(plan, recipe, { headline: "速報", "dynamicStyle.captionFontFamily": "M PLUS Rounded 1c", "dynamicStyle.captionFillColor": "#00FF00" });
    expect(withHeadline.layers).toHaveLength(1);
    expect(withHeadline.layers[0]!.ass).toContain("\\an5\\pos(540,216)");
    expect(withHeadline.captions!.ass).toContain("M PLUS Rounded 1c");
    expect(withHeadline.captions!.ass).toContain("&H0000FF00"); // green text colour (unspoken)
    const noCaptions = buildOverlayDocuments(plan, { ...recipe, captions: { ...recipe.captions, enabled: false } }, {});
    expect(noCaptions.captions).toBeNull();
    const badFont = buildOverlayDocuments(plan, recipe, { "dynamicStyle.captionFontFamily": "Evil,Font;{\\b1}" });
    expect(badFont.captions!.ass).toContain("Noto Sans JP");
  });
});

describe("runProcess extensions", () => {
  it("streams stdout lines, honours cwd and samples CPU on Linux", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lyonix-proc-"));
    try {
      const lines: string[] = [];
      const script = "const fs=require('fs');console.log('cwd='+process.cwd());console.log('a');let t=Date.now();while(Date.now()-t<1200){}console.log('b')";
      const result = await runProcess(process.execPath, ["-e", script], { timeoutMs: 15_000, cwd: dir, onStdoutLine: (line) => lines.push(line), sampleCpu: true });
      expect(result.exitCode).toBe(0);
      expect(lines.slice(1)).toEqual(["a", "b"]);
      expect(lines[0]!.replaceAll("\\", "/")).toContain(dir.replaceAll("\\", "/").split("/").at(-1));
      // sampled every 200 ms, so it is a lower bound that lags on a loaded runner: assert "measured and plausible", not a tight value
      if (process.platform === "linux") {
        expect(result.cpuSeconds).toBeGreaterThan(0.05);
        expect(result.cpuSeconds).toBeLessThan(5);
      } else expect(result.cpuSeconds ?? null).toBeNull();
      const noSample = await runProcess(process.execPath, ["-e", "1"], { timeoutMs: 15_000 });
      expect("cpuSeconds" in noSample).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("job lock", () => {
  it("is exclusive, releasable and takes over a stale lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lyonix-lock-"));
    try {
      let now = new Date("2026-01-01T00:00:00Z");
      const release = await acquireJobLock(dir, "k", 1000, () => now);
      await expect(acquireJobLock(dir, "k", 1000, () => now)).rejects.toBeInstanceOf(JobLockBusyError);
      now = new Date(Date.now() + 60_000); // lock mtime is the real clock: move well past the stale threshold
      const takeover = await acquireJobLock(dir, "k", 1000, () => now);
      await takeover();
      await release();
      const again = await acquireJobLock(dir, "k", 1000, () => new Date());
      await again();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("startComposeConsumer", () => {
  const QUEUE = "lyonix.render.test";
  const setup = async (processor: Pick<ComposeProcessor, "handle">) => {
    const broker = new InMemoryMediaJobBroker();
    const channel = broker.createChannel();
    const consumer = await startComposeConsumer({ channel, queue: QUEUE, prefetch: 1, processor: processor as ComposeProcessor, lockRetryDelayMs: 10 });
    const client = broker.createChannel();
    const reply = await client.assertQueue("");
    const received: Array<{ type?: string | undefined; body: unknown }> = [];
    await client.consume(reply.queue, (m) => {
      if (m) received.push({ type: m.properties.type, body: JSON.parse(m.content.toString()) });
    }, { noAck: true });
    const send = (body: unknown, raw?: string) => client.sendToQueue(QUEUE, Buffer.from(raw ?? JSON.stringify(body)), { replyTo: reply.queue, correlationId: "c1", messageId: "m1" });
    return { broker, consumer, received, send };
  };
  const tick = () => new Promise((r) => setTimeout(r, 30));

  it("publishes progress then exactly one result for the job, then acks", async () => {
    const result = { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_RESULT_TYPE, ok: false, jobKey: "k1", error: { code: "QC_DURATION", message: "m", retryable: false, attempts: 1 }, completedAt: "x" };
    const { received, send, consumer } = await setup({
      handle: async (_raw: unknown, onProgress?: (p: never) => void) => {
        onProgress?.({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_PROGRESS_TYPE, jobKey: "k1", stage: "encoding", percent: 50, frame: 1, totalFrames: 2, speedX: 1 } as never);
        return result as never;
      },
    });
    send({ type: VIDEO_COMPOSE_JOB_TYPE, jobKey: "k1" });
    await tick();
    expect(received.map((r) => r.type)).toEqual([VIDEO_COMPOSE_PROGRESS_TYPE, VIDEO_COMPOSE_RESULT_TYPE]);
    expect(parseVideoComposeProgress(received[0]!.body)?.percent).toBe(50);
    expect(parseVideoComposeResult(received[1]!.body)).not.toBeNull();
    await consumer.drain();
  });

  it("answers poison messages with INVALID_JOB instead of requeueing them forever", async () => {
    const { received, send, broker } = await setup({ handle: async () => { throw new Error("must not be called"); } });
    send(null, "{not json");
    send({ type: "clip.prepare", jobKey: "wrong" });
    await tick();
    expect(received.map((r) => (r.body as { error: { code: string } }).error.code)).toEqual(["INVALID_JOB", "INVALID_JOB"]);
    expect(broker.depth(QUEUE)).toBe(0);
  });

  it("requeues a job whose lock is held elsewhere, and reports unexpected errors as retryable INTERNAL", async () => {
    let calls = 0;
    const { received, send } = await setup({
      handle: async () => {
        calls += 1;
        if (calls === 1) throw new JobLockBusyError("k2");
        if (calls === 2) throw new Error("boom");
        return { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: VIDEO_COMPOSE_RESULT_TYPE, ok: false, jobKey: "k2", error: { code: "QC_FPS", message: "m", retryable: false, attempts: 1 }, completedAt: "x" } as never;
      },
    });
    send({ type: VIDEO_COMPOSE_JOB_TYPE, jobKey: "k2" });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(2); // 1st: lock busy -> requeued; 2nd: boom -> INTERNAL result and ack
    expect((received[0]!.body as { error: { code: string; retryable: boolean } }).error).toMatchObject({ code: "INTERNAL", retryable: true });
  });
});

describe("TTL sweep covers video.compose renders", () => {
  it("removes an expired render directory and keeps a live one", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { sweepExpiredMediaJobs } = await import("../ttl-sweep.js");
    const root = await mkdtemp(join(tmpdir(), "lyonix-sweep-"));
    try {
      for (const [name, expiresAt] of [["old", "2026-10-01T00:00:00.000Z"], ["live", "2026-10-20T00:00:00.000Z"]] as const) {
        const dir = join(root, "working/renders", name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "result.json"), JSON.stringify({ fingerprint: "f", result: { expiresAt, output: { relativePath: "x" } } }));
      }
      expect((await sweepExpiredMediaJobs(root, new Date("2026-10-10T00:00:00Z"))).removed).toBe(1);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(join(root, "working/renders"))).toEqual(["live"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
