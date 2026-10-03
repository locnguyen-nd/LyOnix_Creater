import { createHash } from "node:crypto";
import {
  hasUnsafePathShape,
  isInt,
  isRecord,
  JOB_KEY_RE,
  MAX_CLIP_DURATION_MS,
  MAX_START_MS,
  MEDIA_JOB_ERROR_CODES,
  MEDIA_JOB_SCHEMA_VERSION,
  type MediaJobErrorCode,
  type Validation,
} from "./contract.js";

/**
 * VE2E-66 (CR-SUBJECT-REFRAME-2026-10-02 §3 step 1-2): `reframe.analyze` - the media worker (the only process that runs FFmpeg
 * and the local detectors) samples frames from a stored video/image, finds the subject (face -> person -> salient region) and
 * the overlay (burned-in text, preset logo corners for social sources), runs the pure `planReframe` (VE2E-65) and returns a
 * `CropPlan`. It does NOT cut anything (that is `clip.prepare` + cropPlan, VE2E-67). Same RabbitMQ RPC shape as the other jobs:
 * correlationId + replyTo, idempotent by `jobKey`, working files under the 7-day TTL.
 */

export const REFRAME_ANALYZE_JOB_TYPE = "reframe.analyze" as const;
export const REFRAME_ANALYZE_RESULT_TYPE = "reframe.analyze.result" as const;
/** Bumped whenever sampling/detection/ranking rules change in a way that changes the result. */
export const REFRAME_ANALYZE_PROFILE_VERSION = "reframe-analyze.v1" as const;
export const MAX_REFRAME_WINDOW_MS = MAX_CLIP_DURATION_MS;

/** How to choose the primary subject when several people are found. `largest` (default) = biggest/longest-lived; `center` = closest to the frame centre; `salient` = skip people detection, use the salient region. */
export const REFRAME_SUBJECT_PREFERENCES = ["largest", "center", "salient"] as const;
export type ReframeSubjectPreference = (typeof REFRAME_SUBJECT_PREFERENCES)[number];
/** Origins that carry a burned-in logo/watermark (TikTok / Apify scrapes): the preset corner margins are switched on for these. */
export const REFRAME_SOCIAL_ORIGINS = ["apify", "tiktok"] as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ORIGIN_RE = /^[a-z0-9_-]{1,32}$/;

/** Structurally identical to `CropPlan` in `@lyonix/domain` / `@lyonix/contracts` (media-jobs depends on neither; the worker asserts compatibility at compile time). */
export type ReframeCropPlan = {
  version: string;
  sourceWidthPx: number;
  sourceHeightPx: number;
  targetWidthPx: number;
  targetHeightPx: number;
  durationMs: number;
  zoomPermille: number;
  mode: "static" | "keyframes";
  keyframes: Array<{ tMs: number; xPx: number; yPx: number; widthPx: number; heightPx: number }>;
  primarySubjectId: string | null;
  overlayUnavoidable: boolean;
  residualOverlayPct: number;
  subjectCoveragePct: number;
};

export type ReframeAnalyzeJob = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof REFRAME_ANALYZE_JOB_TYPE;
  /** Idempotency key. Same key + same inputs => stored result. Same key + different inputs => JOB_KEY_CONFLICT. */
  jobKey: string;
  source: { relativePath: string; mediaAssetVersionId?: string | null; kind: "video" | "image"; /** SHA-256 of the source bytes when the caller knows it (VE2E-71 cache key; part of the job identity). */ sourceSha256?: string | null };
  /** Video window to analyse (null = the whole video). Ignored for images. */
  startMs: number | null;
  durationMs: number | null;
  /** Only target supported today. */
  target: { width: 1080; height: 1920 };
  /** Source origin hint, lower-case token (`apify`, `tiktok` => preset logo corner margins on). Null = unknown, no preset. */
  origin: string | null;
  preferredSubject: ReframeSubjectPreference | null;
};

export type ReframeConfidence = {
  /** 0..1, the lower of subject and overlay confidence (PLACEHOLDER heuristics until VE2E-69 measures them). */
  overall: number;
  subject: number;
  overlay: number;
  level: "high" | "medium" | "low";
  reasons: string[];
};

export type ReframeSubjectSource = "face" | "person" | "salient" | "none";

export type ReframeAnalyzeSuccess = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof REFRAME_ANALYZE_RESULT_TYPE;
  ok: true;
  jobKey: string;
  reused: boolean;
  source: { relativePath: string; mediaAssetVersionId: string | null; kind: "video" | "image"; durationMs: number; width: number; height: number };
  /** Analysed window (video); `{0,0}` for images. */
  window: { startMs: number; durationMs: number };
  cropPlan: ReframeCropPlan;
  /** Mirrors `cropPlan.overlayUnavoidable` so callers can branch without opening the plan. */
  overlayUnavoidable: boolean;
  confidence: ReframeConfidence;
  analysis: {
    framesSampled: number;
    framesAnalysed: number;
    subjectSource: ReframeSubjectSource;
    framesWithFace: number;
    framesWithPerson: number;
    textRegions: number;
    presetLogoRegions: number;
    logoTemplateMatches: number;
    warnings: string[];
  };
  /** Wall-clock and memory measurements of this run (not part of the idempotent identity). */
  metrics: { totalMs: number; sampleMs: number; detectMs: number; planMs: number; detectMsPerFrame: number; rssPeakMb: number };
  retentionClass: "working";
  expiresAt: string;
  tool: { profileVersion: typeof REFRAME_ANALYZE_PROFILE_VERSION; ffmpegVersion: string; detectorRuntime: string; models: Record<string, string> };
  completedAt: string;
};

export type ReframeAnalyzeFailure = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof REFRAME_ANALYZE_RESULT_TYPE;
  ok: false;
  jobKey: string;
  error: { code: MediaJobErrorCode; message: string; retryable: boolean; attempts: number };
  completedAt: string;
};

export type ReframeAnalyzeResult = ReframeAnalyzeSuccess | ReframeAnalyzeFailure;

export type ReframeAnalyzeJobInput = {
  jobKey: string;
  source: { relativePath: string; mediaAssetVersionId?: string | null; kind?: "video" | "image"; sourceSha256?: string | null };
  startMs?: number | null;
  durationMs?: number | null;
  origin?: string | null;
  preferredSubject?: ReframeSubjectPreference | null;
};

export const buildReframeAnalyzeJob = (input: ReframeAnalyzeJobInput): ReframeAnalyzeJob => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: REFRAME_ANALYZE_JOB_TYPE,
  jobKey: input.jobKey,
  source: { relativePath: input.source.relativePath, mediaAssetVersionId: input.source.mediaAssetVersionId ?? null, kind: input.source.kind ?? "video", sourceSha256: input.source.sourceSha256 ?? null },
  startMs: input.startMs ?? null,
  durationMs: input.durationMs ?? null,
  target: { width: 1080, height: 1920 },
  origin: input.origin?.trim().toLowerCase() || null,
  preferredSubject: input.preferredSubject ?? null,
});

export const isSocialReframeOrigin = (origin: string | null | undefined): boolean =>
  origin !== null && origin !== undefined && (REFRAME_SOCIAL_ORIGINS as readonly string[]).includes(origin);

export const validateReframeAnalyzeJob = (input: unknown): Validation<ReframeAnalyzeJob> => {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["job must be an object"] };
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MEDIA_JOB_SCHEMA_VERSION}`);
  if (input.type !== REFRAME_ANALYZE_JOB_TYPE) errors.push(`type must be ${REFRAME_ANALYZE_JOB_TYPE}`);
  if (typeof input.jobKey !== "string" || !JOB_KEY_RE.test(input.jobKey)) errors.push("jobKey must match [A-Za-z0-9._:-]{1,160}");
  const source = input.source;
  if (!isRecord(source)) {
    errors.push("source must be an object");
  } else {
    if (typeof source.relativePath !== "string" || source.relativePath.trim() === "" || source.relativePath.length > 512) errors.push("source.relativePath must be a non-empty string");
    else if (hasUnsafePathShape(source.relativePath)) errors.push("source.relativePath must be a safe relative path");
    if (source.mediaAssetVersionId !== undefined && source.mediaAssetVersionId !== null && typeof source.mediaAssetVersionId !== "string") errors.push("source.mediaAssetVersionId must be a string or null");
    if (source.sourceSha256 !== undefined && source.sourceSha256 !== null && (typeof source.sourceSha256 !== "string" || !SHA256_RE.test(source.sourceSha256))) errors.push("source.sourceSha256 must be 64 lower-case hex chars or null");
    if (source.kind !== "video" && source.kind !== "image") errors.push("source.kind must be 'video' or 'image'");
  }
  const startMs = input.startMs ?? null;
  const durationMs = input.durationMs ?? null;
  if (startMs !== null && (!isInt(startMs) || startMs < 0 || startMs > MAX_START_MS)) errors.push("startMs must be an integer >= 0 or null");
  if (durationMs !== null && (!isInt(durationMs) || durationMs < 100 || durationMs > MAX_REFRAME_WINDOW_MS)) errors.push(`durationMs must be an integer in [100, ${MAX_REFRAME_WINDOW_MS}] or null`);
  const target = input.target;
  if (!isRecord(target) || target.width !== 1080 || target.height !== 1920) errors.push("target must be {width:1080,height:1920}");
  const origin = input.origin ?? null;
  if (origin !== null && (typeof origin !== "string" || !ORIGIN_RE.test(origin))) errors.push("origin must be a lower-case token [a-z0-9_-]{1,32} or null");
  const preferred = input.preferredSubject ?? null;
  if (preferred !== null && !(REFRAME_SUBJECT_PREFERENCES as readonly unknown[]).includes(preferred)) errors.push(`preferredSubject must be one of ${REFRAME_SUBJECT_PREFERENCES.join("|")} or null`);
  if (errors.length > 0) return { ok: false, errors };
  const src = source as Record<string, unknown>;
  return {
    ok: true,
    value: {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: REFRAME_ANALYZE_JOB_TYPE,
      jobKey: input.jobKey as string,
      source: { relativePath: (src.relativePath as string).replaceAll("\\", "/"), mediaAssetVersionId: (src.mediaAssetVersionId as string | null | undefined) ?? null, kind: src.kind as "video" | "image", sourceSha256: (src.sourceSha256 as string | null | undefined) ?? null },
      startMs: startMs as number | null,
      durationMs: durationMs as number | null,
      target: { width: 1080, height: 1920 },
      origin: origin as string | null,
      preferredSubject: preferred as ReframeSubjectPreference | null,
    },
  };
};

/** Deterministic key per (asset, window, origin, preference, profile): a retried workflow step re-requests the same key and gets the stored plan. */
export const buildReframeAnalyzeJobKey = (input: {
  /** Preferred identity: SHA-256 of the source bytes, so the same content analysed twice (any asset row, any retry) shares one key. */
  sourceSha256?: string | null;
  sourceMediaAssetVersionId?: string;
  startMs?: number | null;
  durationMs?: number | null;
  origin?: string | null;
  preferredSubject?: ReframeSubjectPreference | null;
  profileVersion?: string;
}): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.sourceSha256 ?? input.sourceMediaAssetVersionId ?? "", input.startMs ?? null, input.durationMs ?? null, input.origin ?? null, input.preferredSubject ?? null, input.profileVersion ?? REFRAME_ANALYZE_PROFILE_VERSION]))
    .digest("hex");
  return `reframe:${digest.slice(0, 40)}`;
};

/** Fingerprint of the job inputs; the worker uses it to detect JOB_KEY_CONFLICT. (Env/config changes recompute instead, see the worker's config digest.) */
export const reframeAnalyzeFingerprint = (job: ReframeAnalyzeJob): string =>
  createHash("sha256")
    .update(JSON.stringify({ profile: REFRAME_ANALYZE_PROFILE_VERSION, source: job.source.relativePath, sourceSha256: job.source.sourceSha256 ?? null, kind: job.source.kind, startMs: job.startMs, durationMs: job.durationMs, target: job.target, origin: job.origin, preferredSubject: job.preferredSubject }))
    .digest("hex");

export const parseReframeAnalyzeResult = (input: unknown): ReframeAnalyzeResult | null => {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION || input.type !== REFRAME_ANALYZE_RESULT_TYPE) return null;
  if (typeof input.jobKey !== "string" || typeof input.ok !== "boolean") return null;
  if (input.ok) {
    const plan = input.cropPlan;
    if (!isRecord(plan) || !Array.isArray(plan.keyframes) || typeof plan.overlayUnavoidable !== "boolean") return null;
    if (!isRecord(input.confidence) || typeof input.confidence.overall !== "number") return null;
    return input as unknown as ReframeAnalyzeSuccess;
  }
  const error = input.error;
  if (!isRecord(error) || typeof error.code !== "string" || !(MEDIA_JOB_ERROR_CODES as readonly string[]).includes(error.code)) return null;
  return input as unknown as ReframeAnalyzeFailure;
};
