import { createHash } from "node:crypto";
import {
  hasUnsafePathShape,
  isInt,
  isRecord,
  JOB_KEY_RE,
  MEDIA_JOB_ERROR_CODES,
  MEDIA_JOB_SCHEMA_VERSION,
  type Validation,
} from "./contract.js";

/**
 * VE2E-104: `video.compose` - the internal `lyonix` render engine. The API sends a fully resolved RenderPlan (media/voice as
 * `MEDIA_ROOT`-relative paths) plus a recipe reference to the render queue; `apps/media-worker` (the only FFmpeg process)
 * composes the 1080x1920 60 fps MP4, runs QC and replies with the output, a thumbnail and the QC report. Same RabbitMQ RPC
 * shape as `clip.prepare` (correlationId + replyTo, idempotent by `jobKey`), plus optional `video.compose.progress` messages
 * on the same reply queue. Output lives under `working/renders/` (7-day TTL class, local disk only).
 */

export const VIDEO_COMPOSE_JOB_TYPE = "video.compose" as const;
export const VIDEO_COMPOSE_RESULT_TYPE = "video.compose.result" as const;
export const VIDEO_COMPOSE_PROGRESS_TYPE = "video.compose.progress" as const;
/** Bumped whenever the filtergraph/encode/QC rules change in a way that changes output bytes. */
export const COMPOSE_PROFILE_VERSION = "compose.v1" as const;
/** Dedicated queue so long renders never starve clip.prepare / frame.extract on `lyonix.media`. */
export const DEFAULT_RENDER_QUEUE = "lyonix.render";

/** The only output the engine produces (hard requirement: 60 fps CFR, vertical 1080x1920, H.264 MP4). */
export const COMPOSE_TARGET = { width: 1080, height: 1920, fps: 60, videoCodec: "h264", container: "mp4" } as const;
export type ComposeTarget = typeof COMPOSE_TARGET;

export const MAX_COMPOSE_SCENES = 200;
export const MAX_COMPOSE_FRAMES = COMPOSE_TARGET.fps * 30 * 60; // 30 minutes
export const MAX_COMPOSE_TEXT_LENGTH = 2000;
export const MAX_COMPOSE_CUES_PER_SCENE = 200;

export type ComposeSceneEffect = { kind: "none" | "zoom_in" | "zoom_out" | "pan"; intensity?: number };
export type ComposeTransition = { kind: "none" | "fade" | "wipe" | "slide" | "circle"; durationMs: number };

export type ComposeFileRef = {
  /** Relative to MEDIA_ROOT. Never absolute. */
  relativePath: string;
  /** Echoed for lineage; the worker never reads the DB. */
  mediaAssetVersionId?: string | null;
  /** When given it is part of the fingerprint, so replaced file contents never reuse a stored render. */
  sha256?: string | null;
};

export type ComposeScene = {
  sceneId: string;
  startFrame: number;
  durationFrames: number;
  media: ComposeFileRef & { kind: "image" | "video"; sourceStartMs?: number | null; sourceDurationMs?: number | null };
  voice: ComposeFileRef & { durationMs: number };
  /** Static on-screen text for the scene (may be empty). */
  text: string;
  captionCues: Array<{ text: string; startMs: number; endMs: number; charTimings?: Array<{ startMs: number; endMs: number }> }>;
  effectIn: ComposeSceneEffect;
  effectOut: ComposeSceneEffect;
  transitionIn: ComposeTransition;
};

export type ComposePlan = {
  canvas: { width: number; height: number };
  fps: number;
  padStartFrames: number;
  padEndFrames: number;
  totalFrames: number;
  scenes: ComposeScene[];
  music: (ComposeFileRef & { volume: number }) | null;
  /** Template-level option values (secondary text/colour/font/volume), validated against the recipe's slots by the worker. */
  params: Record<string, string>;
};

export type ComposeRecipeRef = { id: string; version: number };

export type VideoComposeJob = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof VIDEO_COMPOSE_JOB_TYPE;
  jobKey: string;
  recipe: ComposeRecipeRef;
  plan: ComposePlan;
};

export type VideoComposeJobInput = Omit<VideoComposeJob, "schemaVersion" | "type">;

/** QC check codes; a failed check becomes the failure's error code. */
export const COMPOSE_QC_CODES = [
  "QC_RESOLUTION",
  "QC_FPS",
  "QC_CODEC",
  "QC_DURATION",
  "QC_AUDIO",
  "QC_LOUDNESS",
  "QC_TRUE_PEAK",
  "QC_BLACK_FRAMES",
  "QC_FREEZE",
] as const;
export type ComposeQcCode = (typeof COMPOSE_QC_CODES)[number];

export const COMPOSE_ERROR_CODES = [...MEDIA_JOB_ERROR_CODES, "RECIPE_NOT_FOUND", "RECIPE_INVALID", "FONT_MISSING", ...COMPOSE_QC_CODES] as const;
export type ComposeErrorCode = (typeof COMPOSE_ERROR_CODES)[number];

/**
 * Failures caused by the job's own data: the Render Router must NOT fall back to a paid provider for these (the provider would
 * get the same bad input). Everything else (FFmpeg crash/timeout, QC failure, missing font/recipe, ...) is a technical failure.
 */
export const COMPOSE_INPUT_ERROR_CODES: readonly ComposeErrorCode[] = [
  "INVALID_JOB",
  "JOB_KEY_CONFLICT",
  "SOURCE_UNSAFE_PATH",
  "SOURCE_NOT_FOUND",
  "NO_VIDEO_STREAM",
  "RANGE_OUT_OF_BOUNDS",
];
export const isComposeInputError = (code: string): boolean => (COMPOSE_INPUT_ERROR_CODES as readonly string[]).includes(code);

export type ComposeQcCheck = {
  code: ComposeQcCode;
  ok: boolean;
  /** What was measured / what the standard requires, stringified for humans (numbers stay numbers). */
  measured: number | string | null;
  expected: number | string | null;
  message: string;
};

export type ComposeQcMeasurements = {
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  profile: string | null;
  pixFmt: string | null;
  durationMs: number | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  integratedLufs: number | null;
  truePeakDbtp: number | null;
  blackMs: number | null;
  freezeMs: number | null;
};

export type ComposeQcReport = {
  passed: boolean;
  checks: ComposeQcCheck[];
  measured: ComposeQcMeasurements;
};

export type ComposeOutputFile = {
  /** Relative to MEDIA_ROOT, under `working/renders/`. */
  relativePath: string;
  mimeType: "video/mp4" | "image/jpeg";
  sha256: string;
  bytes: number;
};

export type VideoComposeSuccess = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof VIDEO_COMPOSE_RESULT_TYPE;
  ok: true;
  jobKey: string;
  /** true when served from the idempotency store (no FFmpeg run this delivery). */
  reused: boolean;
  output: ComposeOutputFile & { mimeType: "video/mp4"; durationMs: number; width: number; height: number; fps: number };
  thumbnail: ComposeOutputFile & { mimeType: "image/jpeg"; width: number; height: number };
  qc: ComposeQcReport;
  metrics: { renderMs: number; cpuSeconds: number | null; x264Preset: string; x264Threads: number };
  retentionClass: "working";
  expiresAt: string;
  tool: { profileVersion: typeof COMPOSE_PROFILE_VERSION; ffmpegVersion: string; recipe: ComposeRecipeRef };
  completedAt: string;
};

export type VideoComposeFailure = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof VIDEO_COMPOSE_RESULT_TYPE;
  ok: false;
  jobKey: string;
  error: { code: ComposeErrorCode; message: string; retryable: boolean; attempts: number };
  /** Present when the failure is a QC failure: the full report, so the cause is visible without the video. */
  qc?: ComposeQcReport | null;
  completedAt: string;
};

export type VideoComposeResult = VideoComposeSuccess | VideoComposeFailure;

export type VideoComposeProgress = {
  schemaVersion: typeof MEDIA_JOB_SCHEMA_VERSION;
  type: typeof VIDEO_COMPOSE_PROGRESS_TYPE;
  jobKey: string;
  stage: "preparing" | "encoding" | "qc" | "finalizing";
  /** 0..100 */
  percent: number;
  /** Encoded frames so far / total, when stage === "encoding". */
  frame: number | null;
  totalFrames: number | null;
  speedX: number | null;
};

// ---------------------------------------------------------------------------------------------------------------------

/** Canonical JSON: object keys sorted, so the same plan always hashes the same regardless of construction order. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Fingerprint of everything that determines output bytes (jobKey excluded); used by the worker to detect JOB_KEY_CONFLICT. */
export const composeFingerprint = (job: Pick<VideoComposeJob, "recipe" | "plan">): string =>
  createHash("sha256")
    .update(canonicalJson({ profile: COMPOSE_PROFILE_VERSION, target: COMPOSE_TARGET, recipe: job.recipe, plan: job.plan }))
    .digest("hex");

/** Deterministic job key: the same resolved plan + recipe + profile always asks for the same key and gets the stored render back. */
export const buildComposeJobKey = (job: Pick<VideoComposeJob, "recipe" | "plan">): string => `compose:${composeFingerprint(job).slice(0, 40)}`;

export const buildVideoComposeJob = (input: VideoComposeJobInput): VideoComposeJob => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: VIDEO_COMPOSE_JOB_TYPE,
  jobKey: input.jobKey,
  recipe: input.recipe,
  plan: input.plan,
});

const RECIPE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const EFFECT_KINDS = ["none", "zoom_in", "zoom_out", "pan"];
const TRANSITION_KINDS = ["none", "fade", "wipe", "slide", "circle"];

const validateFileRef = (label: string, value: unknown, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (typeof value.relativePath !== "string" || value.relativePath.trim() === "" || value.relativePath.length > 512) errors.push(`${label}.relativePath must be a non-empty string`);
  else if (hasUnsafePathShape(value.relativePath)) errors.push(`${label}.relativePath must be a safe relative path`);
  if (value.mediaAssetVersionId !== undefined && value.mediaAssetVersionId !== null && typeof value.mediaAssetVersionId !== "string") errors.push(`${label}.mediaAssetVersionId must be a string or null`);
  if (value.sha256 !== undefined && value.sha256 !== null && (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256))) errors.push(`${label}.sha256 must be 64 hex chars or null`);
};

const validateEffect = (label: string, value: unknown, errors: string[]): void => {
  if (!isRecord(value) || typeof value.kind !== "string" || !EFFECT_KINDS.includes(value.kind)) errors.push(`${label}.kind must be one of ${EFFECT_KINDS.join("|")}`);
  else if (value.intensity !== undefined && (typeof value.intensity !== "number" || !Number.isFinite(value.intensity) || value.intensity < 0 || value.intensity > 1)) errors.push(`${label}.intensity must be in [0, 1]`);
};

/** Structural validation of an untrusted job payload (client-side before send and worker-side on receive). */
export const validateVideoComposeJob = (input: unknown): Validation<VideoComposeJob> => {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["job must be an object"] };
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION) errors.push(`schemaVersion must be ${MEDIA_JOB_SCHEMA_VERSION}`);
  if (input.type !== VIDEO_COMPOSE_JOB_TYPE) errors.push(`type must be ${VIDEO_COMPOSE_JOB_TYPE}`);
  if (typeof input.jobKey !== "string" || !JOB_KEY_RE.test(input.jobKey)) errors.push("jobKey must match [A-Za-z0-9._:-]{1,160}");
  const recipe = input.recipe;
  if (!isRecord(recipe) || typeof recipe.id !== "string" || !RECIPE_ID_RE.test(recipe.id) || !isInt(recipe.version) || recipe.version < 1 || recipe.version > 10_000) {
    errors.push("recipe must be {id: [a-z0-9._-]{1,80}, version: integer >= 1}");
  }
  const plan = input.plan;
  if (!isRecord(plan)) {
    errors.push("plan must be an object");
    return { ok: false, errors };
  }
  const canvas = plan.canvas;
  if (!isRecord(canvas) || canvas.width !== COMPOSE_TARGET.width || canvas.height !== COMPOSE_TARGET.height) errors.push(`plan.canvas must be ${COMPOSE_TARGET.width}x${COMPOSE_TARGET.height}`);
  if (plan.fps !== COMPOSE_TARGET.fps) errors.push(`plan.fps must be ${COMPOSE_TARGET.fps} (hard requirement)`);
  for (const key of ["padStartFrames", "padEndFrames", "totalFrames"] as const) {
    if (!isInt(plan[key]) || (plan[key] as number) < 0 || (plan[key] as number) > MAX_COMPOSE_FRAMES) errors.push(`plan.${key} must be an integer in [0, ${MAX_COMPOSE_FRAMES}]`);
  }
  if (!isRecord(plan.params) || Object.values(plan.params).some((v) => typeof v !== "string" || v.length > MAX_COMPOSE_TEXT_LENGTH)) errors.push("plan.params must be a string map");
  if (plan.music !== null && plan.music !== undefined) {
    validateFileRef("plan.music", plan.music, errors);
    if (isRecord(plan.music) && (typeof plan.music.volume !== "number" || !Number.isFinite(plan.music.volume) || plan.music.volume < 0 || plan.music.volume > 1)) errors.push("plan.music.volume must be in [0, 1]");
  }
  const scenes = plan.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0 || scenes.length > MAX_COMPOSE_SCENES) {
    errors.push(`plan.scenes must have 1..${MAX_COMPOSE_SCENES} entries`);
  } else {
    let cursor = isInt(plan.padStartFrames) ? plan.padStartFrames : 0;
    const ids = new Set<string>();
    scenes.forEach((scene, index) => {
      const label = `plan.scenes[${index}]`;
      if (!isRecord(scene)) {
        errors.push(`${label} must be an object`);
        return;
      }
      if (typeof scene.sceneId !== "string" || scene.sceneId === "" || scene.sceneId.length > 100 || ids.has(scene.sceneId)) errors.push(`${label}.sceneId must be a unique non-empty string`);
      else ids.add(scene.sceneId);
      if (!isInt(scene.startFrame) || !isInt(scene.durationFrames) || scene.durationFrames < 1) {
        errors.push(`${label}.startFrame/durationFrames must be integers (duration >= 1)`);
      } else {
        if (scene.startFrame !== cursor) errors.push(`${label}.startFrame must continue the previous scene (expected ${cursor})`);
        cursor = scene.startFrame + scene.durationFrames;
      }
      validateFileRef(`${label}.media`, scene.media, errors);
      if (isRecord(scene.media)) {
        if (scene.media.kind !== "image" && scene.media.kind !== "video") errors.push(`${label}.media.kind must be image|video`);
        const start = scene.media.sourceStartMs;
        const dur = scene.media.sourceDurationMs;
        if ((start === undefined || start === null) !== (dur === undefined || dur === null)) errors.push(`${label}.media sourceStartMs/sourceDurationMs must both be set or both empty`);
        else if (start !== undefined && start !== null && (!isInt(start) || start < 0 || !isInt(dur) || dur < 1)) errors.push(`${label}.media source range is invalid`);
      }
      validateFileRef(`${label}.voice`, scene.voice, errors);
      if (isRecord(scene.voice) && (!isInt(scene.voice.durationMs) || scene.voice.durationMs < 1)) errors.push(`${label}.voice.durationMs must be a positive integer`);
      if (typeof scene.text !== "string" || scene.text.length > MAX_COMPOSE_TEXT_LENGTH) errors.push(`${label}.text must be a string <= ${MAX_COMPOSE_TEXT_LENGTH} chars`);
      if (!Array.isArray(scene.captionCues) || scene.captionCues.length > MAX_COMPOSE_CUES_PER_SCENE) {
        errors.push(`${label}.captionCues must be an array (<= ${MAX_COMPOSE_CUES_PER_SCENE})`);
      } else {
        scene.captionCues.forEach((cue, cueIndex) => {
          if (!isRecord(cue) || typeof cue.text !== "string" || cue.text.length > MAX_COMPOSE_TEXT_LENGTH || typeof cue.startMs !== "number" || typeof cue.endMs !== "number" || !(cue.endMs > cue.startMs) || cue.startMs < 0) {
            errors.push(`${label}.captionCues[${cueIndex}] must have text and 0 <= startMs < endMs`);
          } else if (cue.charTimings !== undefined && (!Array.isArray(cue.charTimings) || cue.charTimings.length !== Array.from(cue.text).length)) {
            errors.push(`${label}.captionCues[${cueIndex}].charTimings must have one entry per character`);
          }
        });
      }
      validateEffect(`${label}.effectIn`, scene.effectIn, errors);
      validateEffect(`${label}.effectOut`, scene.effectOut, errors);
      const transition = scene.transitionIn;
      if (!isRecord(transition) || typeof transition.kind !== "string" || !TRANSITION_KINDS.includes(transition.kind) || !isInt(transition.durationMs) || transition.durationMs < 0 || transition.durationMs > 5000) {
        errors.push(`${label}.transitionIn must be {kind, durationMs 0..5000}`);
      }
    });
    if (isInt(plan.totalFrames) && isInt(plan.padEndFrames) && plan.totalFrames !== cursor + plan.padEndFrames) {
      errors.push(`plan.totalFrames must equal the last scene end + padEndFrames (expected ${cursor + plan.padEndFrames})`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const value = input as unknown as VideoComposeJob;
  return {
    ok: true,
    value: {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: VIDEO_COMPOSE_JOB_TYPE,
      jobKey: value.jobKey,
      recipe: { id: value.recipe.id, version: value.recipe.version },
      plan: {
        ...value.plan,
        scenes: value.plan.scenes.map((scene) => ({
          ...scene,
          media: { ...scene.media, relativePath: scene.media.relativePath.replaceAll("\\", "/") },
          voice: { ...scene.voice, relativePath: scene.voice.relativePath.replaceAll("\\", "/") },
        })),
        music: value.plan.music ? { ...value.plan.music, relativePath: value.plan.music.relativePath.replaceAll("\\", "/") } : null,
      },
    },
  };
};

/** Loose structural check of a result message received by the client. */
export const parseVideoComposeResult = (input: unknown): VideoComposeResult | null => {
  if (!isRecord(input)) return null;
  if (input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION || input.type !== VIDEO_COMPOSE_RESULT_TYPE) return null;
  if (typeof input.jobKey !== "string" || typeof input.ok !== "boolean") return null;
  if (input.ok) {
    const output = input.output;
    const thumbnail = input.thumbnail;
    const qc = input.qc;
    if (!isRecord(output) || typeof output.relativePath !== "string" || typeof output.sha256 !== "string") return null;
    if (!isRecord(thumbnail) || typeof thumbnail.relativePath !== "string") return null;
    if (!isRecord(qc) || typeof qc.passed !== "boolean" || !Array.isArray(qc.checks)) return null;
    return input as unknown as VideoComposeSuccess;
  }
  const error = input.error;
  if (!isRecord(error) || typeof error.code !== "string" || !(COMPOSE_ERROR_CODES as readonly string[]).includes(error.code)) return null;
  return input as unknown as VideoComposeFailure;
};

export const parseVideoComposeProgress = (input: unknown): VideoComposeProgress | null => {
  if (!isRecord(input) || input.schemaVersion !== MEDIA_JOB_SCHEMA_VERSION || input.type !== VIDEO_COMPOSE_PROGRESS_TYPE) return null;
  if (typeof input.jobKey !== "string" || typeof input.percent !== "number" || !Number.isFinite(input.percent)) return null;
  return input as unknown as VideoComposeProgress;
};

