import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isSupportedTtsAudioMimeType, sniffAudioFormat, validateGeneratedAudio } from "./audio-format.js";

const mp3Buffer = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00]), Buffer.alloc(200, 1)]);
const mp3FrameSyncBuffer = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200, 2)]);
const wavBuffer = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE"), Buffer.alloc(200, 3)]);
const oggBuffer = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(200, 4)]);
const garbageBuffer = Buffer.alloc(200, 9);

describe("sniffAudioFormat", () => {
  it("recognizes an MP3 with an ID3 tag", () => { expect(sniffAudioFormat(mp3Buffer)).toBe("audio/mpeg"); });
  it("recognizes a raw MP3 frame sync", () => { expect(sniffAudioFormat(mp3FrameSyncBuffer)).toBe("audio/mpeg"); });
  it("recognizes a WAV container", () => { expect(sniffAudioFormat(wavBuffer)).toBe("audio/wav"); });
  it("recognizes an OGG container", () => { expect(sniffAudioFormat(oggBuffer)).toBe("audio/ogg"); });
  it("returns null for unrecognized bytes", () => { expect(sniffAudioFormat(garbageBuffer)).toBeNull(); });
});

describe("isSupportedTtsAudioMimeType", () => {
  it("accepts common aliases", () => {
    expect(isSupportedTtsAudioMimeType("audio/mpeg")).toBe(true);
    expect(isSupportedTtsAudioMimeType("audio/mp3")).toBe(true);
    expect(isSupportedTtsAudioMimeType("audio/wave")).toBe(true);
  });
  it("rejects an unknown mime type", () => { expect(isSupportedTtsAudioMimeType("video/mp4")).toBe(false); });
});

describe("validateGeneratedAudio", () => {
  it("accepts a well-formed MP3 with a positive alignment duration", () => {
    const result = validateGeneratedAudio({ buffer: mp3Buffer, declaredMimeType: "audio/mpeg", alignmentDurationMs: 1234 });
    expect(result).toEqual({
      ok: true,
      checksumSha256: createHash("sha256").update(mp3Buffer).digest("hex"),
      bytes: mp3Buffer.length,
      durationMs: 1234,
      mimeType: "audio/mpeg",
    });
  });

  it("rejects an empty/too-small buffer", () => {
    expect(validateGeneratedAudio({ buffer: Buffer.alloc(4), declaredMimeType: "audio/mpeg", alignmentDurationMs: 500 })).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects an unrecognized container", () => {
    expect(validateGeneratedAudio({ buffer: garbageBuffer, declaredMimeType: "audio/mpeg", alignmentDurationMs: 500 })).toEqual({ ok: false, reason: "unrecognized_format" });
  });

  it("rejects when the declared MIME does not match the sniffed container", () => {
    expect(validateGeneratedAudio({ buffer: wavBuffer, declaredMimeType: "audio/mpeg", alignmentDurationMs: 500 })).toEqual({ ok: false, reason: "mime_mismatch" });
  });

  it("rejects a non-positive alignment duration", () => {
    expect(validateGeneratedAudio({ buffer: mp3Buffer, declaredMimeType: "audio/mpeg", alignmentDurationMs: 0 })).toEqual({ ok: false, reason: "invalid_duration" });
  });

  it("rejects a duration beyond the max bound", () => {
    expect(validateGeneratedAudio({ buffer: mp3Buffer, declaredMimeType: "audio/mpeg", alignmentDurationMs: 999_999, maxDurationMs: 1000 })).toEqual({ ok: false, reason: "duration_too_long" });
  });
});
