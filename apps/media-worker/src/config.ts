import { isAbsolute, resolve } from "node:path";
import { DEFAULT_MEDIA_WORKER_QUEUE } from "@lyonix/media-jobs";

export type MediaWorkerConfig = {
  queue: string;
  /** null => not configured; main.ts fails fast with a clear message. */
  rabbitmqUrl: string | null;
  mediaRoot: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** DEC-2026-09-29 §3: max start/duration drift (ms) accepted for stream copy before switching to re-encode. */
  copyToleranceMs: number;
  /** Hard timeout per FFmpeg/ffprobe invocation attempt. */
  jobTimeoutMs: number;
  /** Bounded retries for retryable failures (FFMPEG_FAILED / FFMPEG_TIMEOUT). */
  maxAttempts: number;
  prefetch: number;
  sweepIntervalMs: number;
};

export class MediaWorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaWorkerConfigError";
  }
}

const readInt = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MediaWorkerConfigError(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
  }
  return value;
};

/**
 * Env contract (all optional except RABBITMQ_URL at runtime):
 * - MEDIA_WORKER_QUEUE (default `lyonix.media`), RABBITMQ_URL
 * - MEDIA_ROOT (default `./data/media`, resolved against the repo root like apps/api)
 * - FFMPEG_PATH / FFPROBE_PATH (default `ffmpeg` / `ffprobe` on PATH)
 * - MEDIA_WORKER_COPY_TOLERANCE_MS (default 1000), MEDIA_WORKER_JOB_TIMEOUT_MS (default 120000),
 *   MEDIA_WORKER_MAX_ATTEMPTS (default 2), MEDIA_WORKER_PREFETCH (default 1),
 *   MEDIA_WORKER_SWEEP_INTERVAL_MS (default 6h)
 */
export const loadMediaWorkerConfig = (env: NodeJS.ProcessEnv, repoRoot: string): MediaWorkerConfig => {
  const mediaRootRaw = env.MEDIA_ROOT?.trim() || "./data/media";
  return {
    queue: env.MEDIA_WORKER_QUEUE?.trim() || DEFAULT_MEDIA_WORKER_QUEUE,
    rabbitmqUrl: env.RABBITMQ_URL?.trim() || null,
    mediaRoot: isAbsolute(mediaRootRaw) ? mediaRootRaw : resolve(repoRoot, mediaRootRaw),
    ffmpegPath: env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: env.FFPROBE_PATH?.trim() || "ffprobe",
    copyToleranceMs: readInt(env, "MEDIA_WORKER_COPY_TOLERANCE_MS", 1000, 0, 10_000),
    jobTimeoutMs: readInt(env, "MEDIA_WORKER_JOB_TIMEOUT_MS", 120_000, 1_000, 30 * 60_000),
    maxAttempts: readInt(env, "MEDIA_WORKER_MAX_ATTEMPTS", 2, 1, 5),
    prefetch: readInt(env, "MEDIA_WORKER_PREFETCH", 1, 1, 16),
    sweepIntervalMs: readInt(env, "MEDIA_WORKER_SWEEP_INTERVAL_MS", 6 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000),
  };
};
