import { createHash } from "node:crypto";
import type { ReframeCropPlan } from "./reframe-contract.js";

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
/**
 * VE2E-67: version of the crop-apply recipe (keyframed `crop` expression + lanczos scale to 1080x1920, still image = one JPEG).
 * Only part of the job fingerprint / lineage when a `cropPlan` (or an image source) is present, so legacy keys/manifests are unchanged.
 */
export const CLIP_CROP_PROFILE_VERSION = "crop-apply.v1" as const;
export const MAX_CROP_KEYFRAMES = 512;

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
    /** VE2E-67: `image` = still source (output is one 1080x1920 JPEG, `startMs`/`durationMs` are ignored). Omitted = `video`. */
    kind?: "video" | "image";
  };
  startMs: number;
  durationMs: number;
  /**
   * VE2E-67 (CR-SUBJECT-REFRAME §3 step 3): crop plan from `reframe.analyze` (VE2E-65/66). Its keyframe `tMs` are relative to the
   * cut start (`startMs`) and its source size must equal the source's displayed size. Absent/null = legacy centre-cover crop.
   * A plan that is not the whole frame forces a re-encode (never stream copy).
   */
  cropPlan?: ReframeCropPlan | null;
  /** true => output has no audio track at all (`-an`). Mandatory for social sources (DEC-2026-09-29 §1). */
  stripAudio: boolean;
  target: ClipTarget;
};

export type ClipPrepareMode = "copy" | "reencode";

export type ClipPrepareOutput = {
  /** Relative to MEDIA_ROOT, under `working/` (7-day TTL class, local disk only). */
  relativePath: string;
  /** `image/jpeg` only for `source.kind === "image"` jobs (VE2E-67). */
  mimeType: "video/mp4" | "image/jpeg";
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

/** VE2E-67 lineage of an applied crop plan (additive; absent when the job had no `cropPlan`). */
export type ClipPrepareReframe = {
  /** `crop`: the plan's window was cut; `full_frame`: the plan covers the whole frame (no pixels removed, copy allowed). */
  applied: "crop" | "full_frame";
  planVersion: string;
  mode: "static" | "keyframes";
  zoomPermille: number;
  /** SHA-256 of the canonical plan JSON ({@link cropPlanDigest}); part of the job identity. */
  cropPlanSha256: string;
  primarySubjectId: string | null;
  overlayUnavoidable: boolean;
  residualOverlayPct: number;
  subjectCoveragePct: number;
  cropProfileVersion: typeof CLIP_CROP_PROFILE_VERSION;
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
    kind?: "video" | "image";
  };
  output: ClipPrepareOutput;
  /** VE2E-67: set when the job carried a `cropPlan`. */
  reframe?: ClipPrepareReframe | null;
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
  /** VE2E-66: a detector model file is missing/corrupt (checksum) or the detector runtime is not installed. Never silently degraded. */
  "MODEL_NOT_AVAILABLE",
  "DETECTOR_FAILED",
  "DETECTOR_TIMEOUT",
  "INTERNAL",
  /** VE2E-144: media.fetch / media.search (yt-dlp, gallery-dl) failure reasons - see fetch-contract.ts. */
  "FETCH_FORBIDDEN",
  "FETCH_BOT_CHECK",
  "FETCH_COOKIES_INVALID",
  "FETCH_RATE_LIMITED",
  "FETCH_UNAVAILABLE",
  "FETCH_EXTRACTOR_BROKEN",
  "FETCH_TOO_LARGE",
  "FETCH_TIMEOUT",
  "FETCH_NETWORK",
  "FETCH_TOOL_MISSING",
  "FETCH_FAILED",
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

/** Canonical (key-order independent) JSON digest of a crop plan; the same plan always hashes the same, so it can be part of a jobKey. */
export const cropPlanDigest = (plan: ReframeCropPlan): string =>
  createHash("sha256")
    .update(JSON.stringify([
      plan.version, plan.sourceWidthPx, plan.sourceHeightPx, plan.targetWidthPx, plan.targetHeightPx, plan.durationMs, plan.zoomPermille, plan.mode,
      plan.keyframes.map((k) => [k.tMs, k.xPx, k.yPx, k.widthPx, k.heightPx]),
      plan.primarySubjectId, plan.overlayUnavoidable, plan.residualOverlayPct, plan.subjectCoveragePct,
    ]))
    .digest("hex");

/** Structural check of an untrusted crop plan (the worker re-checks it against the real source size). Returns error strings. */
export const validateCropPlanShape = (input: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(input)) return ["cropPlan must be an object"];
  const posInt = (value: unknown): value is number => isInt(value) && value > 0 && value <= 20_000;
  if (typeof input.version !== "string" || input.version.length === 0 || input.version.length > 40) errors.push("cropPlan.version must be a short string");
  for (const key of ["sourceWidthPx", "sourceHeightPx", "targetWidthPx", "targetHeightPx"] as const) if (!posInt(input[key])) errors.push(`cropPlan.${key} must be a positive integer`);
  if (input.targetWidthPx !== 1080 || input.targetHeightPx !== 1920) errors.push("cropPlan target must be 1080x1920");
  if (input.mode !== "static" && input.mode !== "keyframes") errors.push("cropPlan.mode must be static|keyframes");
  if (!isInt(input.durationMs) || input.durationMs < 0) errors.push("cropPlan.durationMs must be an integer >= 0");
  if (!isInt(input.zoomPermille) || input.zoomPermille < 1000 || input.zoomPermille > 10_000) errors.push("cropPlan.zoomPermille must be an integer in [1000, 10000]");
  if (typeof input.overlayUnavoidable !== "boolean") errors.push("cropPlan.overlayUnavoidable must be a boolean");
  for (const key of ["residualOverlayPct", "subjectCoveragePct"] as const) {
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) errors.push(`cropPlan.${key} must be a number in [0, 100]`);
  }
  if (input.primarySubjectId !== null && input.primarySubjectId !== undefined && typeof input.primarySubjectId !== "string") errors.push("cropPlan.primarySubjectId must be a string or null");
  const keyframes = input.keyframes;
  if (!Array.isArray(keyframes) || keyframes.length === 0 || keyframes.length > MAX_CROP_KEYFRAMES) {
    errors.push(`cropPlan.keyframes must have 1..${MAX_CROP_KEYFRAMES} entries`);
    return errors;
  }
  if (input.mode === "static" && keyframes.length !== 1) errors.push("static cropPlan must have exactly one keyframe");
  const sourceW = input.sourceWidthPx as number;
  const sourceH = input.sourceHeightPx as number;
  let previousT = -1;
  let size: { w: number; h: number } | null = null;
  for (const [index, frame] of keyframes.entries()) {
    if (!isRecord(frame) || !isInt(frame.tMs) || !isInt(frame.xPx) || !isInt(frame.yPx) || !posInt(frame.widthPx) || !posInt(frame.heightPx)) {
      errors.push(`cropPlan.keyframes[${index}] must have integer tMs/xPx/yPx/widthPx/heightPx`);
      continue;
    }
    if (frame.tMs < 0 || (index === 0 && frame.tMs !== 0) || frame.tMs <= previousT) errors.push(`cropPlan.keyframes[${index}].tMs must start at 0 and strictly increase`);
    previousT = frame.tMs;
    if (frame.xPx < 0 || frame.yPx < 0 || (typeof sourceW === "number" && frame.xPx + frame.widthPx > sourceW) || (typeof sourceH === "number" && frame.yPx + frame.heightPx > sourceH)) {
      errors.push(`cropPlan.keyframes[${index}] window lies outside the source frame`);
    }
    if (Math.abs(frame.widthPx / frame.heightPx - 1080 / 1920) > 0.012) errors.push(`cropPlan.keyframes[${index}] is not 9:16`);
    if (size && (size.w !== frame.widthPx || size.h !== frame.heightPx)) errors.push("cropPlan keyframes must all have the same window size (constant zoom)");
    size ??= { w: frame.widthPx, h: frame.heightPx };
  }
  return errors;
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
  const kind = isRecord(source) ? source.kind : undefined;
  if (kind !== undefined && kind !== "video" && kind !== "image") errors.push("source.kind must be 'video' or 'image'");
  const isImage = kind === "image";
  // A still image has no time range: both fields are ignored (normalised to 0).
  if (!isImage) {
    if (!isInt(input.startMs) || input.startMs < 0 || input.startMs > MAX_START_MS) errors.push("startMs must be an integer >= 0");
    if (!isInt(input.durationMs) || input.durationMs < 100 || input.durationMs > MAX_CLIP_DURATION_MS) {
      errors.push(`durationMs must be an integer in [100, ${MAX_CLIP_DURATION_MS}]`);
    }
  }
  const cropPlan = input.cropPlan ?? null;
  if (cropPlan !== null) errors.push(...validateCropPlanShape(cropPlan));
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
        ...(isImage ? { kind: "image" as const } : {}),
      },
      startMs: isImage ? 0 : (input.startMs as number),
      durationMs: isImage ? 0 : (input.durationMs as number),
      stripAudio: input.stripAudio as boolean,
      target: { ...DEFAULT_CLIP_TARGET },
      ...(cropPlan !== null ? { cropPlan: cropPlan as ReframeCropPlan } : {}),
    },
  };
};

export type ClipPrepareJobInput = Omit<ClipPrepareJob, "schemaVersion" | "type" | "target"> & { target?: ClipTarget };

export const buildClipPrepareJob = (input: ClipPrepareJobInput): ClipPrepareJob => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: CLIP_PREPARE_JOB_TYPE,
  jobKey: input.jobKey,
  source: { relativePath: input.source.relativePath, mediaAssetVersionId: input.source.mediaAssetVersionId ?? null, ...(input.source.kind === "image" ? { kind: "image" as const } : {}) },
  startMs: input.startMs,
  durationMs: input.durationMs,
  stripAudio: input.stripAudio,
  target: input.target ?? { ...DEFAULT_CLIP_TARGET },
  ...(input.cropPlan ? { cropPlan: input.cropPlan } : {}),
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
  /** VE2E-67: the crop plan (or its {@link cropPlanDigest}) is part of the job identity; absent = the legacy key, unchanged. */
  cropPlan?: ReframeCropPlan | null;
  cropPlanSha256?: string | null;
  /** VE2E-67: still-image source (key differs from the video key of the same asset). */
  kind?: "video" | "image";
}): string => {
  const cropDigest = input.cropPlanSha256 ?? (input.cropPlan ? cropPlanDigest(input.cropPlan) : null);
  const parts: unknown[] = [
    input.sourceMediaAssetVersionId,
    input.startMs,
    input.durationMs,
    input.stripAudio,
    input.profileVersion ?? CLIP_PREPARE_PROFILE_VERSION,
  ];
  if (cropDigest) parts.push({ crop: cropDigest, cropProfile: CLIP_CROP_PROFILE_VERSION });
  if (input.kind === "image") parts.push({ kind: "image" });
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
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
      // VE2E-67: only present when set, so fingerprints of legacy (crop-less video) jobs are byte-identical to before.
      ...(job.cropPlan ? { crop: cropPlanDigest(job.cropPlan), cropProfile: CLIP_CROP_PROFILE_VERSION } : {}),
      ...(job.source.kind === "image" ? { kind: "image" } : {}),
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
