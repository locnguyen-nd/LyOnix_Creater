import { createHash } from "node:crypto";

/**
 * VE2E-36 (CR-JP-ONESHOT-MEDIA-2026-09-29 §3/§5, DEC-2026-09-29-JP-ONESHOT-MEDIA):
 * wire contract between a job producer (API / workflow worker — wired in VE2E-37) and
 * `apps/media-worker`, the only process allowed to run FFmpeg. Transport is RabbitMQ:
 * the producer sends a `clip.prepare` job to `MEDIA_WORKER_QUEUE` with `correlationId` +
 * `replyTo`; the worker publishes exactly one `ClipPrepareResult` back to `replyTo` with
 * the same `correlationId`. Jobs are idempotent by `jobKey`: re-sending the same job
 * returns the stored result without re-running FFmpeg.
 */

export const MEDIA_JOB_SCHEMA_VERSION = "media-job.v1" as const;
export const DEFAULT_MEDIA_WORKER_QUEUE = "lyonix.media";
export const CLIP_PREPARE_JOB_TYPE = "clip.prepare" as const;
export const CLIP_PREPARE_RESULT_TYPE = "clip.prepare.result" as const;
/** Bumped whenever the FFmpeg encode profile/decision rules change in a way that changes output bytes. */
export const CLIP_PREPARE_PROFILE_VERSION = "clip-prepare.v1" as const;

/** Only target the worker supports today: vertical 1080x1920 H.264 MP4, scale-to-cover + centre crop on re-encode. */
export type ClipTarget = {
  width: 1080;
  height: 1920;
  videoCodec: "h264";
  container: "mp4";
  fit: "cover";
};

export const DEFAULT_CLIP_TARGET: ClipTarget = { width: 1080, height: 1920, videoCodec: "h264", container: "mp4", fit: "cover" };

export type ClipPrepareJob = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof CLIP_PREPARE_JOB_TYPE;
  /** Idempotency key. Same key + same inputs => same stored result. Same key + different inputs => JOB_KEY_CONFLICT. */
  jobKey: string;
  source: {
    /** `MediaAssetVersion.relativePath` (relative to MEDIA_ROOT). Never an absolute/client path. */
    relativePath: string;
    /** Echoed back for lineage only; the worker never reads the DB. */
    mediaAssetVersionId?: string | null;
  };
  startMs: number;
  durationMs: number;
  /** true => output has no audio track at all (`-an`). Mandatory for social sources (DEC-2026-09-29 §1). */
  stripAudio: boolean;
  target: ClipTarget;
};

export type ClipPrepareMode = "copy" | "reencode";

export type ClipPrepareOutput = {
  /** Relative to MEDIA_ROOT, under `working/` (7-day TTL class, local disk only). */
  relativePath: string;
  mimeType: "video/mp4";
  sha256: string;
  bytes: number;
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string;
  hasAudio: boolean;
  retentionClass: "working";
  expiresAt: string;
};

export type ClipPrepareSuccess = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof CLIP_PREPARE_RESULT_TYPE;
  ok: true;
  jobKey: string;
  /** true when the result was served from the idempotency store (no FFmpeg run this delivery). */
  reused: boolean;
  mode: ClipPrepareMode;
  /** Why copy was not used (empty when mode === "copy"). */
  reencodeReasons: string[];
  /** Actual cut start/duration applied to the source (copy mode snaps to a keyframe). */
  cut: { startMs: number; durationMs: number };
  /** Signed drifts vs. the requested range: actual - requested (ms). */
  drift: { startMs: number; durationMs: number };
  toleranceMs: number;
  source: {
    relativePath: string;
    mediaAssetVersionId: string | null;
    durationMs: number;
    width: number;
    height: number;
    videoCodec: string;
    audioCodec: string | null;
  };
  output: ClipPrepareOutput;
  tool: { profileVersion: typeof CLIP_PREPARE_PROFILE_VERSION; ffmpegVersion: string };
  completedAt: string;
};

export const MEDIA_JOB_ERROR_CODES = [
  "INVALID_JOB",
  "JOB_KEY_CONFLICT",
  "SOURCE_UNSAFE_PATH",
  "SOURCE_NOT_FOUND",
  "PROBE_FAILED",
  "NO_VIDEO_STREAM",
  "RANGE_OUT_OF_BOUNDS",
  "FFMPEG_FAILED",
  "FFMPEG_TIMEOUT",
  "OUTPUT_INVALID",
  "INTERNAL",
] as const;
export type MediaJobErrorCode = (typeof MEDIA_JOB_ERROR_CODES)[number];

export type ClipPrepareFailure = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof CLIP_PREPARE_RESULT_TYPE;
  ok: false;
  jobKey: string;
  error: { code: MediaJobErrorCode; message: string; retryable: boolean; attempts: number };
  completedAt: string;
};

export type ClipPrepareResult = ClipPrepareSuccess | ClipPrepareFailure;

/** Client-side error codes (never produced by the worker). */
export type MediaJobClientErrorCode = "MEDIA_WORKER_NOT_CONFIGURED" | "BROKER_UNAVAILABLE" | "RESULT_TIMEOUT" | "INVALID_JOB" | "INVALID_RESULT";

export class MediaJobClientError extends Error {
  readonly code: MediaJobClientErrorCode;
  constructor(code: MediaJobClientErrorCode, message: string) {
    super(message);
    this.name = "MediaJobClientError";
    this.code = code;
  }
}

export const JOB_KEY_RE = /^[A-Za-z0-9._:-]{1,160}$/;
/** Upper bound for a single prepared clip; segments are ~6-20s (CR §4), 5 min is a generous hard cap. */
export const MAX_CLIP_DURATION_MS = 5 * 60 * 1000;
export const MAX_START_MS = 24 * 60 * 60 * 1000;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

export const hasUnsafePathShape = (relativePath: string): boolean => {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.startsWith("~") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === ".." || segment === ".")
  );
};

/** Structural validation of an untrusted job payload (both client-side before send and worker-side on receive). */
export const validateClipPrepareJob = (input: unknown): Validation<ClipPrepareJob> => {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["job must be an object"] };
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MEDIA_JOB_SCHEMA_VERSION}`);
  if (input.type !== CLIP_PREPARE_JOB_TYPE) errors.push(`type must be ${CLIP_PREPARE_JOB_TYPE}`);
  if (typeof input.jobKey !== "string" || !JOB_KEY_RE.test(input.jobKey)) errors.push("jobKey must match [A-Za-z0-9._:-]{1,160}");
  const source = input.source;
  if (!isRecord(source)) {
    errors.push("source must be an object");
  } else {
    if (typeof source.relativePath !== "string" || source.relativePath.trim() === "" || source.relativePath.length > 512) {
      errors.push("source.relativePath must be a non-empty string");
    } else if (hasUnsafePathShape(source.relativePath)) {
      errors.push("source.relativePath must be a safe relative path");
    }
    if (source.mediaAssetVersionId !== undefined && source.mediaAssetVersionId !== null && typeof source.mediaAssetVersionId !== "string") {
      errors.push("source.mediaAssetVersionId must be a string or null");
    }
  }
  if (!isInt(input.startMs) || input.startMs < 0 || input.startMs > MAX_START_MS) errors.push("startMs must be an integer >= 0");
  if (!isInt(input.durationMs) || input.durationMs < 100 || input.durationMs > MAX_CLIP_DURATION_MS) {
    errors.push(`durationMs must be an integer in [100, ${MAX_CLIP_DURATION_MS}]`);
  }
  if (typeof input.stripAudio !== "boolean") errors.push("stripAudio must be a boolean");
  const target = input.target;
  if (
    !isRecord(target) ||
    target.width !== DEFAULT_CLIP_TARGET.width ||
    target.height !== DEFAULT_CLIP_TARGET.height ||
    target.videoCodec !== "h264" ||
    target.container !== "mp4" ||
    target.fit !== "cover"
  ) {
    errors.push("target must be {width:1080,height:1920,videoCodec:'h264',container:'mp4',fit:'cover'}");
  }
  if (errors.length > 0) return { ok: false, errors };
  const src = source as Record<string, unknown>;
  return {
    ok: true,
    value: {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: CLIP_PREPARE_JOB_TYPE,
      jobKey: input.jobKey as string,
      source: {
        relativePath: (src.relativePath as string).replaceAll("\\", "/"),
        mediaAssetVersionId: (src.mediaAssetVersionId as string | null | undefined) ?? null,
      },
      startMs: input.startMs as number,
      durationMs: input.durationMs as number,
      stripAudio: input.stripAudio as boolean,
      target: { ...DEFAULT_CLIP_TARGET },
    },
  };
};

export type ClipPrepareJobInput = Omit<ClipPrepareJob, "schemaVersion" | "type" | "target"> & { target?: ClipTarget };

export const buildClipPrepareJob = (input: ClipPrepareJobInput): ClipPrepareJob => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: CLIP_PREPARE_JOB_TYPE,
  jobKey: input.jobKey,
  source: { relativePath: input.source.relativePath, mediaAssetVersionId: input.source.mediaAssetVersionId ?? null },
  startMs: input.startMs,
  durationMs: input.durationMs,
  stripAudio: input.stripAudio,
  target: input.target ?? { ...DEFAULT_CLIP_TARGET },
});

/**
 * Deterministic job key for a (source asset, range, audio policy, profile) tuple so a
 * retried workflow step / re-rendered timeline re-requests the same key and gets the
 * stored derivative back instead of a duplicate FFmpeg run.
 */
export const buildClipPrepareJobKey = (input: {
  sourceMediaAssetVersionId: string;
  startMs: number;
  durationMs: number;
  stripAudio: boolean;
  profileVersion?: string;
}): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      input.sourceMediaAssetVersionId,
      input.startMs,
      input.durationMs,
      input.stripAudio,
      input.profileVersion ?? CLIP_PREPARE_PROFILE_VERSION,
    ]))
    .digest("hex");
  return `clip:${digest.slice(0, 40)}`;
};

/** Fingerprint of the inputs that determine output bytes; used by the worker to detect JOB_KEY_CONFLICT. */
export const clipPrepareFingerprint = (job: ClipPrepareJob): string =>
  createHash("sha256")
    .update(JSON.stringify({
      profile: CLIP_PREPARE_PROFILE_VERSION,
      source: job.source.relativePath,
      startMs: job.startMs,
      durationMs: job.durationMs,
      stripAudio: job.stripAudio,
      target: job.target,
    }))
    .digest("hex");

/** Loose structural check of a result message received by the client. */
export const parseClipPrepareResult = (input: unknown): ClipPrepareResult | null => {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION || input.type !== CLIP_PREPARE_RESULT_TYPE) return null;
  if (typeof input.jobKey !== "string" || typeof input.ok !== "boolean") return null;
  if (input.ok) {
    const output = input.output;
    if (!isRecord(output) || typeof output.relativePath !== "string" || typeof output.sha256 !== "string") return null;
    if (input.mode !== "copy" && input.mode !== "reencode") return null;
    return input as unknown as ClipPrepareSuccess;
  }
  const error = input.error;
  if (!isRecord(error) || typeof error.code !== "string" || !(MEDIA_JOB_ERROR_CODES as readonly string[]).includes(error.code)) return null;
  return input as unknown as ClipPrepareFailure;
};
