import { describe, expect, it } from "vitest";
import { MediaJobClient } from "./client.js";
import {
  buildFrameExtractJob,
  buildFrameExtractJobKey,
  FRAME_EXTRACT_RESULT_TYPE,
  frameExtractFingerprint,
  MAX_FRAME_EXTRACT_COUNT,
  parseFrameExtractResult,
  validateFrameExtractJob,
} from "./frame-contract.js";
import { MEDIA_JOB_SCHEMA_VERSION } from "./contract.js";
import { InMemoryMediaJobBroker } from "./testing.js";

const input = { jobKey: "frames:t1", source: { relativePath: "projects/p/assets/a.mp4", mediaAssetVersionId: "mav-1" }, frameCount: 3 };

describe("frame.extract contract", () => {
  it("builds a job with defaults and validates it", () => {
    const job = buildFrameExtractJob(input);
    expect(job).toMatchObject({ type: "frame.extract", frameCount: 3, windowStartMs: null, windowDurationMs: null, maxWidth: 640 });
    expect(validateFrameExtractJob(job)).toMatchObject({ ok: true });
  });

  it("rejects unsafe paths, out-of-range counts/widths and bad windows", () => {
    const bad = (override: Record<string, unknown>) => validateFrameExtractJob({ ...buildFrameExtractJob(input), ...override });
    expect(bad({ source: { relativePath: "../x.mp4" } }).ok).toBe(false);
    expect(bad({ source: { relativePath: "/abs/x.mp4" } }).ok).toBe(false);
    expect(bad({ frameCount: 0 }).ok).toBe(false);
    expect(bad({ frameCount: MAX_FRAME_EXTRACT_COUNT + 1 }).ok).toBe(false);
    expect(bad({ maxWidth: 50 }).ok).toBe(false);
    expect(bad({ windowStartMs: -1 }).ok).toBe(false);
    expect(bad({ windowDurationMs: 10 }).ok).toBe(false);
    expect(bad({ jobKey: "has space" }).ok).toBe(false);
  });

  it("derives a deterministic job key and a fingerprint that changes with the inputs", () => {
    const a = buildFrameExtractJobKey({ sourceMediaAssetVersionId: "mav-1", frameCount: 3 });
    expect(a).toBe(buildFrameExtractJobKey({ sourceMediaAssetVersionId: "mav-1", frameCount: 3 }));
    expect(a).not.toBe(buildFrameExtractJobKey({ sourceMediaAssetVersionId: "mav-1", frameCount: 4 }));
    expect(a).toMatch(/^frames:[0-9a-f]{40}$/);
    expect(frameExtractFingerprint(buildFrameExtractJob(input))).not.toBe(frameExtractFingerprint(buildFrameExtractJob({ ...input, frameCount: 2 })));
  });

  it("parses worker results and refuses malformed ones", () => {
    const ok = { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: FRAME_EXTRACT_RESULT_TYPE, ok: true, jobKey: "k", frames: [{ relativePath: "working/media-jobs/a/frame-0.jpg", sha256: "0".repeat(64) }] };
    expect(parseFrameExtractResult(ok)).not.toBeNull();
    expect(parseFrameExtractResult({ ...ok, frames: [{ relativePath: 1 }] })).toBeNull();
    expect(parseFrameExtractResult({ ...ok, type: "clip.prepare.result" })).toBeNull();
    expect(parseFrameExtractResult({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: FRAME_EXTRACT_RESULT_TYPE, ok: false, jobKey: "k", error: { code: "NOPE", message: "", retryable: false, attempts: 0 } })).toBeNull();
  });
});

describe("MediaJobClient.extractFrames", () => {
  it("round-trips a frame.extract job through the queue with the correlated result", async () => {
    const broker = new InMemoryMediaJobBroker();
    const workerChannel = broker.createChannel();
    await workerChannel.assertQueue("q.frames");
    await workerChannel.consume("q.frames", (message) => {
      if (!message) return;
      const job = JSON.parse(message.content.toString("utf8")) as { jobKey: string; type: string };
      workerChannel.sendToQueue(message.properties.replyTo!, Buffer.from(JSON.stringify({
        schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: FRAME_EXTRACT_RESULT_TYPE, ok: true, jobKey: job.jobKey, reused: false,
        frames: [{ relativePath: "working/media-jobs/a/frame-0.jpg", sha256: "0".repeat(64) }], skippedFrames: 0,
      })), message.properties.correlationId ? { correlationId: message.properties.correlationId } : {});
      workerChannel.ack(message);
    });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q.frames", defaultTimeoutMs: 2_000 });
    const result = await client.extractFrames(input);
    expect(result.ok).toBe(true);
    expect(broker.published[0]!.options.type).toBe("frame.extract");
    await client.close();
  });

  it("rejects an invalid job before anything is published, and times out when nobody answers", async () => {
    const broker = new InMemoryMediaJobBroker();
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q.none", defaultTimeoutMs: 50 });
    await expect(client.extractFrames({ ...input, frameCount: 99 })).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(broker.published).toHaveLength(0);
    await expect(client.extractFrames(input)).rejects.toMatchObject({ code: "RESULT_TIMEOUT" });
    await client.close();
  });
});
