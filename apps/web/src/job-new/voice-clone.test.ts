import { describe, expect, it } from "vitest";
import { VOICE_CLONE_CONSENT_VERSION, VOICE_CLONE_LIMITS, buildConsent, checkSamples, formatBytes, isAudioSample, sampleMimeType } from "./voice-clone";

const file = (name: string, size = 1024, type = "audio/mpeg") => ({ name, size, type });
const MB = 1024 * 1024;

describe("voice clone sample checks", () => {
  it("accepts 1-5 audio files within the size limits", () => {
    expect(checkSamples([file("a.mp3")])).toBeNull();
    expect(checkSamples(Array.from({ length: VOICE_CLONE_LIMITS.maxFiles }, (_, i) => file(`${i}.mp3`, 3 * MB)))).toBeNull();
  });

  it("flags too many files, non-audio files, an oversized file and an oversized total", () => {
    expect(checkSamples(Array.from({ length: VOICE_CLONE_LIMITS.maxFiles + 1 }, (_, i) => file(`${i}.mp3`)))).toBe("tooMany");
    expect(checkSamples([file("notes.pdf", 10, "application/pdf")])).toBe("notAudio");
    expect(checkSamples([file("big.wav", VOICE_CLONE_LIMITS.maxFileBytes + 1)])).toBe("fileTooLarge");
    expect(checkSamples([file("a.wav", 9 * MB), file("b.wav", 9 * MB), file("c.wav", 9 * MB)])).toBe("totalTooLarge");
  });

  it("an empty mime type still counts as audio when the extension is a known audio one", () => {
    expect(isAudioSample(file("voice.m4a", 1, ""))).toBe(true);
    expect(isAudioSample(file("voice.txt", 1, ""))).toBe(false);
    expect(sampleMimeType(file("voice.m4a", 1, ""))).toBe("audio/mp4");
    expect(sampleMimeType(file("voice.mp3", 1, "audio/mpeg"))).toBe("audio/mpeg");
  });

  it("formats sizes and stamps the consent with its version, text and time", () => {
    expect(formatBytes(512)).toBe("1 KB");
    expect(formatBytes(2.5 * MB)).toBe("2.5 MB");
    expect(buildConsent("I agree", new Date("2026-10-09T00:00:00.000Z"))).toEqual({ statementVersion: VOICE_CLONE_CONSENT_VERSION, statementText: "I agree", acceptedAt: "2026-10-09T00:00:00.000Z" });
  });
});
