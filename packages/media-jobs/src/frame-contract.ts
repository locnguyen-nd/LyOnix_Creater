import { createHash } from "node:crypto";
import {
  hasUnsafePathShape,
  isInt,
  isRecord,
  JOB_KEY_RE,
  MAX_START_MS,
  MEDIA_JOB_ERROR_CODES,
  MEDIA_JOB_SCHEMA_VERSION,
  type MediaJobErrorCode,
  type Validation,
} from "./contract.js";

/**
 * VE2E-30: `frame.extract` — the media worker (the only FFmpeg process) samples a few JPEG frames from a stored video
 * so the SAME vision-moderation pipeline used for photos can judge video candidates. Same RabbitMQ RPC shape as
 * `clip.prepare` (correlationId + replyTo, idempotent by `jobKey`, outputs under `working/` with the 7-day TTL).
 */

export const FRAME_EXTRACT_JOB_TYPE = "frame.extract" as const;
export const FRAME_EXTRACT_RESULT_TYPE = "frame.extract.result" as const;
/** Bumped whenever the sampling/encode rules change in a way that changes output bytes. */
export const FRAME_EXTRACT_PROFILE_VERSION = "frame-extract.v1" as const;
/** Mirrors `MAX_MODERATION_FRAMES` in packages/providers (vision-moderation.ts): a video never yields more frames than one moderation call accepts. */
export const MAX_FRAME_EXTRACT_COUNT = 6;
/** Decoded per-frame cap, the same ~2.2MB bound the vision call enforces on base64 (3,000,000 chars). */
export const MAX_FRAME_EXTRACT_BYTES = 2_200_000;
export const DEFAULT_FRAME_MAX_WIDTH = 640;
export const MIN_FRAME_MAX_WIDTH = 160;
export const MAX_FRAME_MAX_WIDTH = 1280;

export type FrameExtractJob = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof FRAME_EXTRACT_JOB_TYPE;
  jobKey: string;
  source: { relativePath: string; mediaAssetVersionId?: string | null };
  /** 1..MAX_FRAME_EXTRACT_COUNT frames, sampled evenly inside the (guarded) window. */
  frameCount: number;
  /** Optional window of the source to sample (default: the whole video minus a small head/tail margin). */
  windowStartMs: number | null;
  windowDurationMs: number | null;
  /** Frames are scaled down to at most this width (never up); JPEG. */
  maxWidth: number;
};

export type ExtractedFrame = {
  /** Relative to MEDIA_ROOT, under `working/` (7-day TTL class). */
  relativePath: string;
  mimeType: "image/jpeg";
  atMs: number;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

export type FrameExtractSuccess = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof FRAME_EXTRACT_RESULT_TYPE;
  ok: true;
  jobKey: string;
  reused: boolean;
  source: { relativePath: string; mediaAssetVersionId: string | null; durationMs: number; width: number; height: number };
  frames: ExtractedFrame[];
  /** Frames that could not be produced under the byte cap (reported, never silently dropped). */
  skippedFrames: number;
  retentionClass: "working";
  expiresAt: string;
  tool: { profileVersion: typeof FRAME_EXTRACT_PROFILE_VERSION; ffmpegVersion: string };
  completedAt: string;
};

export type FrameExtractFailure = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof FRAME_EXTRACT_RESULT_TYPE;
  ok: false;
  jobKey: string;
  error: { code: MediaJobErrorCode; message: string; retryable: boolean; attempts: number };
  completedAt: string;
};

export type FrameExtractResult = FrameExtractSuccess | FrameExtractFailure;

export type FrameExtractJobInput = {
  jobKey: string;
  source: { relativePath: string; mediaAssetVersionId?: string | null };
  frameCount: number;
  windowStartMs?: number | null;
  windowDurationMs?: number | null;
  maxWidth?: number;
};

export const buildFrameExtractJob = (input: FrameExtractJobInput): FrameExtractJob => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: FRAME_EXTRACT_JOB_TYPE,
  jobKey: input.jobKey,
  source: { relativePath: input.source.relativePath, mediaAssetVersionId: input.source.mediaAssetVersionId ?? null },
  frameCount: input.frameCount,
  windowStartMs: input.windowStartMs ?? null,
  windowDurationMs: input.windowDurationMs ?? null,
  maxWidth: input.maxWidth ?? DEFAULT_FRAME_MAX_WIDTH,
});

export const validateFrameExtractJob = (input: unknown): Validation<FrameExtractJob> => {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["job must be an object"] };
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MEDIA_JOB_SCHEMA_VERSION}`);
  if (input.type !== FRAME_EXTRACT_JOB_TYPE) errors.push(`type must be ${FRAME_EXTRACT_JOB_TYPE}`);
  if (typeof input.jobKey !== "string" || !JOB_KEY_RE.test(input.jobKey)) errors.push("jobKey must match [A-Za-z0-9._:-]{1,160}");
  const source = input.source;
  if (!isRecord(source)) {
    errors.push("source must be an object");
  } else if (typeof source.relativePath !== "string" || source.relativePath.trim() === "" || source.relativePath.length > 512) {
    errors.push("source.relativePath must be a non-empty string");
  } else if (hasUnsafePathShape(source.relativePath)) {
    errors.push("source.relativePath must be a safe relative path");
  } else if (source.mediaAssetVersionId !== undefined && source.mediaAssetVersionId !== null && typeof source.mediaAssetVersionId !== "string") {
    errors.push("source.mediaAssetVersionId must be a string or null");
  }
  if (!isInt(input.frameCount) || input.frameCount < 1 || input.frameCount > MAX_FRAME_EXTRACT_COUNT) errors.push(`frameCount must be an integer in [1, ${MAX_FRAME_EXTRACT_COUNT}]`);
  const windowStart = input.windowStartMs ?? null;
  const windowDuration = input.windowDurationMs ?? null;
  if (windowStart !== null && (!isInt(windowStart) || windowStart < 0 || windowStart > MAX_START_MS)) errors.push("windowStartMs must be an integer >= 0 or null");
  if (windowDuration !== null && (!isInt(windowDuration) || windowDuration < 100 || windowDuration > MAX_START_MS)) errors.push("windowDurationMs must be an integer >= 100 or null");
  if (!isInt(input.maxWidth) || input.maxWidth < MIN_FRAME_MAX_WIDTH || input.maxWidth > MAX_FRAME_MAX_WIDTH) errors.push(`maxWidth must be an integer in [${MIN_FRAME_MAX_WIDTH}, ${MAX_FRAME_MAX_WIDTH}]`);
  if (errors.length > 0) return { ok: false, errors };
  const src = source as Record<string, unknown>;
  return {
    ok: true,
    value: {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: FRAME_EXTRACT_JOB_TYPE,
      jobKey: input.jobKey as string,
      source: { relativePath: (src.relativePath as string).replaceAll("\\", "/"), mediaAssetVersionId: (src.mediaAssetVersionId as string | null | undefined) ?? null },
      frameCount: input.frameCount as number,
      windowStartMs: windowStart as number | null,
      windowDurationMs: windowDuration as number | null,
      maxWidth: input.maxWidth as number,
    },
  };
};

/** Deterministic key per (asset, frame plan, profile): a retried moderation step re-requests the same key and gets the stored frames. */
export const buildFrameExtractJobKey = (input: {
  sourceMediaAssetVersionId: string;
  frameCount: number;
  windowStartMs?: number | null;
  windowDurationMs?: number | null;
  maxWidth?: number;
  profileVersion?: string;
}): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.sourceMediaAssetVersionId, input.frameCount, input.windowStartMs ?? null, input.windowDurationMs ?? null, input.maxWidth ?? DEFAULT_FRAME_MAX_WIDTH, input.profileVersion ?? FRAME_EXTRACT_PROFILE_VERSION]))
    .digest("hex");
  return `frames:${digest.slice(0, 40)}`;
};

/** Fingerprint of the inputs that determine output bytes; the worker uses it to detect JOB_KEY_CONFLICT. */
export const frameExtractFingerprint = (job: FrameExtractJob): string =>
  createHash("sha256")
    .update(JSON.stringify({ profile: FRAME_EXTRACT_PROFILE_VERSION, source: job.source.relativePath, frameCount: job.frameCount, windowStartMs: job.windowStartMs, windowDurationMs: job.windowDurationMs, maxWidth: job.maxWidth }))
    .digest("hex");

export const parseFrameExtractResult = (input: unknown): FrameExtractResult | null => {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION || input.type !== FRAME_EXTRACT_RESULT_TYPE) return null;
  if (typeof input.jobKey !== "string" || typeof input.ok !== "boolean") return null;
  if (input.ok) {
    if (!Array.isArray(input.frames) || input.frames.some((f) => !isRecord(f) || typeof f.relativePath !== "string" || typeof f.sha256 !== "string")) return null;
    return input as unknown as FrameExtractSuccess;
  }
  const error = input.error;
  if (!isRecord(error) || typeof error.code !== "string" || !(MEDIA_JOB_ERROR_CODES as readonly string[]).includes(error.code)) return null;
  return input as unknown as FrameExtractFailure;
};
