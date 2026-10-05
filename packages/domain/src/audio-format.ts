import { createHash } from "node:crypto";

/**
 * Pure audio-container sniffing/validation for provider-generated audio (VE2E-02
 * ElevenLabs TTS). Deliberately does not decode/transcode audio — that would need
 * FFmpeg, which is only allowed in `apps/media-worker`, never in an HTTP request
 * (see project hard rule). This only reads magic bytes to confirm the binary is a
 * real, well-formed container of the declared MIME type before it is persisted.
 */

export type SniffedAudioFormat = "audio/mpeg" | "audio/wav" | "audio/ogg" | "audio/basic";

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length && bytes.every((byte, index) => buffer[offset + index] === byte);

/** MP3: `ID3` tag header, or a raw frame sync (11 set bits: 0xFF followed by 0xE0-0xFF). */
const isMp3 = (buffer: Buffer): boolean =>
  startsWith(buffer, [0x49, 0x44, 0x33]) || (buffer.length >= 2 && buffer[0] === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0);

const isWav = (buffer: Buffer): boolean => startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x41, 0x56, 0x45], 8);

const isOgg = (buffer: Buffer): boolean => startsWith(buffer, [0x4f, 0x67, 0x67, 0x53]);

/** Best-effort container sniff from magic bytes only. `null` when unrecognized. */
export const sniffAudioFormat = (buffer: Buffer): SniffedAudioFormat | null => {
  if (isWav(buffer)) return "audio/wav";
  if (isOgg(buffer)) return "audio/ogg";
  if (isMp3(buffer)) return "audio/mpeg";
  return null;
};

const MIME_ALIASES: Record<string, SniffedAudioFormat> = { "audio/mp3": "audio/mpeg", "audio/mpeg": "audio/mpeg", "audio/wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-wav": "audio/wav", "audio/ogg": "audio/ogg", "audio/basic": "audio/basic" };

export const isSupportedTtsAudioMimeType = (mimeType: string): boolean => mimeType.toLowerCase() in MIME_ALIASES;

export type GeneratedAudioValidationInput = {
  buffer: Buffer;
  declaredMimeType: string;
  /** Last alignment end time in ms — the authoritative duration source for TTS output (no binary duration parsing). */
  alignmentDurationMs: number;
  minBytes?: number;
  maxDurationMs?: number;
};

export type GeneratedAudioValidationResult =
  | { ok: true; checksumSha256: string; bytes: number; durationMs: number; mimeType: SniffedAudioFormat }
  | { ok: false; reason: "empty" | "unrecognized_format" | "mime_mismatch" | "invalid_duration" | "duration_too_long" };

/**
 * Validates a provider-generated audio buffer before it is stored as a
 * `MediaAssetVersion`: non-empty, a recognizable audio container, container matches
 * the declared MIME (guards against a provider silently changing output format),
 * and a sane, bounded duration derived from TTS alignment timestamps.
 */
export const validateGeneratedAudio = (input: GeneratedAudioValidationInput): GeneratedAudioValidationResult => {
  const minBytes = input.minBytes ?? 64;
  if (input.buffer.length < minBytes) return { ok: false, reason: "empty" };
  const sniffed = sniffAudioFormat(input.buffer);
  if (!sniffed) return { ok: false, reason: "unrecognized_format" };
  const declared = MIME_ALIASES[input.declaredMimeType.toLowerCase()];
  if (declared && declared !== sniffed) return { ok: false, reason: "mime_mismatch" };
  if (!Number.isFinite(input.alignmentDurationMs) || input.alignmentDurationMs <= 0) return { ok: false, reason: "invalid_duration" };
  const maxDurationMs = input.maxDurationMs ?? 15 * 60 * 1000;
  if (input.alignmentDurationMs > maxDurationMs) return { ok: false, reason: "duration_too_long" };
  return {
    ok: true,
    checksumSha256: createHash("sha256").update(input.buffer).digest("hex"),
    bytes: input.buffer.length,
    durationMs: Math.round(input.alignmentDurationMs),
    mimeType: sniffed,
  };
};
