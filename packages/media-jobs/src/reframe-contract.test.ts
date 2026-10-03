import { describe, expect, it } from "vitest";
import { MediaJobClient } from "./client.js";
import { MEDIA_JOB_SCHEMA_VERSION } from "./contract.js";
import {
  buildReframeAnalyzeJob,
  buildReframeAnalyzeJobKey,
  isSocialReframeOrigin,
  parseReframeAnalyzeResult,
  REFRAME_ANALYZE_RESULT_TYPE,
  reframeAnalyzeFingerprint,
  validateReframeAnalyzeJob,
} from "./reframe-contract.js";
import { InMemoryMediaJobBroker } from "./testing.js";

const input = { jobKey: "reframe:t1", source: { relativePath: "projects/p/assets/a.mp4", mediaAssetVersionId: "mav-1" } };
const SHA = "a".repeat(64);

describe("reframe.analyze contract", () => {
  it("builds a job with defaults (whole video, 1080x1920, no origin) and validates it", () => {
    const job = buildReframeAnalyzeJob(input);
    expect(job).toMatchObject({ type: "reframe.analyze", startMs: null, durationMs: null, origin: null, preferredSubject: null, target: { width: 1080, height: 1920 }, source: { kind: "video", sourceSha256: null } });
    expect(validateReframeAnalyzeJob(job)).toMatchObject({ ok: true });
  });

  it("normalises the origin hint and knows which origins carry a burned-in logo", () => {
    expect(buildReframeAnalyzeJob({ ...input, origin: " Apify " }).origin).toBe("apify");
    expect(isSocialReframeOrigin("apify")).toBe(true);
    expect(isSocialReframeOrigin("tiktok")).toBe(true);
    expect(isSocialReframeOrigin("pexels")).toBe(false);
    expect(isSocialReframeOrigin(null)).toBe(false);
  });

  it("rejects unsafe paths, bad windows/origins/preferences/checksums and a wrong target", () => {
    const bad = (override: Record<string, unknown>) => validateReframeAnalyzeJob({ ...buildReframeAnalyzeJob(input), ...override });
    expect(bad({ source: { relativePath: "../x.mp4", kind: "video" } }).ok).toBe(false);
    expect(bad({ source: { relativePath: "/abs/x.mp4", kind: "video" } }).ok).toBe(false);
    expect(bad({ source: { relativePath: "a.mp4", kind: "audio" } }).ok).toBe(false);
    expect(bad({ source: { relativePath: "a.mp4", kind: "video", sourceSha256: "XYZ" } }).ok).toBe(false);
    expect(bad({ startMs: -1 }).ok).toBe(false);
    expect(bad({ durationMs: 10 }).ok).toBe(false);
    expect(bad({ origin: "Has Space" }).ok).toBe(false);
    expect(bad({ preferredSubject: "everyone" }).ok).toBe(false);
    expect(bad({ target: { width: 720, height: 1280 } }).ok).toBe(false);
    expect(bad({ jobKey: "has space" }).ok).toBe(false);
    expect(bad({ source: { relativePath: "a.mp4", kind: "video", sourceSha256: SHA }, preferredSubject: "center", origin: "tiktok" }).ok).toBe(true);
  });

  it("keys the job by source checksum + parameters, so identical content shares one key", () => {
    const a = buildReframeAnalyzeJobKey({ sourceSha256: SHA, startMs: 0, durationMs: 8000, origin: "apify" });
    expect(a).toMatch(/^reframe:[0-9a-f]{40}$/);
    expect(a).toBe(buildReframeAnalyzeJobKey({ sourceSha256: SHA, sourceMediaAssetVersionId: "another-asset-row", startMs: 0, durationMs: 8000, origin: "apify" }));
    expect(a).not.toBe(buildReframeAnalyzeJobKey({ sourceSha256: SHA, startMs: 0, durationMs: 8000, origin: null }));
    expect(a).not.toBe(buildReframeAnalyzeJobKey({ sourceSha256: "b".repeat(64), startMs: 0, durationMs: 8000, origin: "apify" }));
    expect(a).not.toBe(buildReframeAnalyzeJobKey({ sourceSha256: SHA, startMs: 0, durationMs: 8000, origin: "apify", preferredSubject: "center" }));
    expect(buildReframeAnalyzeJobKey({ sourceMediaAssetVersionId: "mav-1" })).toBe(buildReframeAnalyzeJobKey({ sourceMediaAssetVersionId: "mav-1" }));
  });

  it("changes the fingerprint with every input that changes the result", () => {
    const base = buildReframeAnalyzeJob(input);
    const fp = reframeAnalyzeFingerprint(base);
    expect(reframeAnalyzeFingerprint(buildReframeAnalyzeJob(input))).toBe(fp);
    expect(reframeAnalyzeFingerprint(buildReframeAnalyzeJob({ ...input, origin: "apify" }))).not.toBe(fp);
    expect(reframeAnalyzeFingerprint(buildReframeAnalyzeJob({ ...input, startMs: 1000 }))).not.toBe(fp);
    expect(reframeAnalyzeFingerprint(buildReframeAnalyzeJob({ ...input, source: { ...input.source, sourceSha256: SHA } }))).not.toBe(fp);
  });

  it("parses success and failure results and rejects malformed ones", () => {
    const failure = { schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: REFRAME_ANALYZE_RESULT_TYPE, ok: false, jobKey: "k", error: { code: "MODEL_NOT_AVAILABLE", message: "m", retryable: false, attempts: 1 }, completedAt: "t" };
    expect(parseReframeAnalyzeResult(failure)).toMatchObject({ ok: false });
    expect(parseReframeAnalyzeResult({ ...failure, error: { ...failure.error, code: "NOPE" } })).toBeNull();
    expect(parseReframeAnalyzeResult({ ...failure, ok: true })).toBeNull(); // success without a cropPlan
    expect(parseReframeAnalyzeResult({ ...failure, type: "clip.prepare.result" })).toBeNull();
    const success = { ...failure, ok: true, cropPlan: { keyframes: [], overlayUnavoidable: false }, confidence: { overall: 0.5 } };
    expect(parseReframeAnalyzeResult(success)).toMatchObject({ ok: true });
  });
});

describe("MediaJobClient.analyzeReframe", () => {
  it("publishes a persistent reframe.analyze job with correlationId/replyTo/messageId=jobKey and resolves with the correlated result", async () => {
    const broker = new InMemoryMediaJobBroker();
    const worker = broker.createChannel();
    await worker.assertQueue("q");
    await worker.consume("q", (message) => {
      if (!message) return;
      const job = JSON.parse(message.content.toString()) as { jobKey: string };
      worker.sendToQueue(message.properties.replyTo!, Buffer.from(JSON.stringify({ schemaVersion: MEDIA_JOB_SCHEMA_VERSION, type: REFRAME_ANALYZE_RESULT_TYPE, ok: false, jobKey: job.jobKey, error: { code: "MODEL_NOT_AVAILABLE", message: "models missing", retryable: false, attempts: 1 }, completedAt: "t" })), { correlationId: message.properties.correlationId! });
      worker.ack(message);
    });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "q" });
    const result = await client.analyzeReframe({ ...input, origin: "apify" }, { timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_NOT_AVAILABLE" } });
    const published = broker.published.find((p) => p.queue === "q")!;
    expect(published.options).toMatchObject({ persistent: true, type: "reframe.analyze", messageId: "reframe:t1", expiration: "1000" });
    expect(JSON.parse(published.content.toString())).toMatchObject({ origin: "apify", target: { width: 1080, height: 1920 } });
    await expect(client.analyzeReframe({ jobKey: "bad key", source: { relativePath: "a.mp4" } })).rejects.toMatchObject({ code: "INVALID_JOB" });
    await expect(client.analyzeReframe(input, { timeoutMs: 20 })).resolves.toBeDefined();
    await client.close();
  });
});
