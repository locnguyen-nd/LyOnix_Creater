import { describe, expect, it } from "vitest";
import {
  buildClipPrepareJob,
  buildClipPrepareJobKey,
  clipPrepareFingerprint,
  DEFAULT_CLIP_TARGET,
  parseClipPrepareResult,
  validateClipPrepareJob,
} from "./contract.js";
import { redactBrokerUrl } from "./transport.js";

const base = () =>
  buildClipPrepareJob({
    jobKey: "clip:abc",
    source: { relativePath: "projects/p1/assets/aa.mp4", mediaAssetVersionId: "mav-1" },
    startMs: 1000,
    durationMs: 6000,
    stripAudio: true,
  });

describe("validateClipPrepareJob", () => {
  it("accepts a well-formed job and defaults the 1080x1920 H.264 target", () => {
    const result = validateClipPrepareJob(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.target).toEqual(DEFAULT_CLIP_TARGET);
  });

  it.each([
    ["absolute posix", "/etc/passwd"],
    ["windows drive", "C:/media/a.mp4"],
    ["traversal", "projects/../../secret.mp4"],
    ["dot segment", "./projects/a.mp4"],
    ["home", "~/a.mp4"],
  ])("rejects unsafe source path (%s)", (_label, relativePath) => {
    const result = validateClipPrepareJob({ ...base(), source: { relativePath } });
    expect(result.ok).toBe(false);
  });

  it("rejects bad ranges, bad keys, missing stripAudio and other targets", () => {
    expect(validateClipPrepareJob({ ...base(), startMs: -1 }).ok).toBe(false);
    expect(validateClipPrepareJob({ ...base(), durationMs: 50 }).ok).toBe(false);
    expect(validateClipPrepareJob({ ...base(), durationMs: 1.5 }).ok).toBe(false);
    expect(validateClipPrepareJob({ ...base(), jobKey: "has space" }).ok).toBe(false);
    expect(validateClipPrepareJob({ ...base(), stripAudio: undefined }).ok).toBe(false);
    expect(validateClipPrepareJob({ ...base(), target: { ...DEFAULT_CLIP_TARGET, width: 720 } }).ok).toBe(false);
    expect(validateClipPrepareJob({ ...base(), type: "frame.extract" }).ok).toBe(false);
    expect(validateClipPrepareJob(null).ok).toBe(false);
  });

  it("normalises backslashes in the relative path", () => {
    const result = validateClipPrepareJob({ ...base(), source: { relativePath: "projects\\p1\\a.mp4" } });
    expect(result.ok && result.value.source.relativePath).toBe("projects/p1/a.mp4");
  });
});

describe("job keys and fingerprints", () => {
  it("buildClipPrepareJobKey is deterministic and sensitive to every input", () => {
    const input = { sourceMediaAssetVersionId: "mav-1", startMs: 0, durationMs: 5000, stripAudio: true };
    const key = buildClipPrepareJobKey(input);
    expect(key).toMatch(/^clip:[0-9a-f]{40}$/);
    expect(buildClipPrepareJobKey(input)).toBe(key);
    expect(buildClipPrepareJobKey({ ...input, startMs: 1 })).not.toBe(key);
    expect(buildClipPrepareJobKey({ ...input, stripAudio: false })).not.toBe(key);
    expect(validateClipPrepareJob({ ...base(), jobKey: key }).ok).toBe(true);
  });

  it("fingerprint ignores jobKey but changes with the range", () => {
    expect(clipPrepareFingerprint({ ...base(), jobKey: "x" })).toBe(clipPrepareFingerprint(base()));
    expect(clipPrepareFingerprint({ ...base(), durationMs: 7000 })).not.toBe(clipPrepareFingerprint(base()));
  });
});

describe("parseClipPrepareResult", () => {
  it("accepts failure results with a known code and rejects unknown shapes", () => {
    const failure = {
      schemaVersion: "media-job.v1",
      type: "clip.prepare.result",
      ok: false,
      jobKey: "k",
      error: { code: "RANGE_OUT_OF_BOUNDS", message: "m", retryable: false, attempts: 1 },
      completedAt: new Date().toISOString(),
    };
    expect(parseClipPrepareResult(failure)).not.toBeNull();
    expect(parseClipPrepareResult({ ...failure, error: { ...failure.error, code: "NOPE" } })).toBeNull();
    expect(parseClipPrepareResult({ ...failure, ok: true })).toBeNull();
    expect(parseClipPrepareResult("x")).toBeNull();
  });
});

describe("redactBrokerUrl", () => {
  it("never leaks credentials", () => {
    const redacted = redactBrokerUrl("amqp://user:s3cret@rabbit:5672/vhost");
    expect(redacted).not.toContain("s3cret");
    expect(redacted).toContain("rabbit:5672");
    expect(redactBrokerUrl("amqp://localhost:5672")).toBe("amqp://localhost:5672");
  });
});
