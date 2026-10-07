import { availableParallelism } from "node:os";
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
  /** Parallel clip.prepare jobs (AMQP prefetch). Default 3, never above the CPU count (VE2E-61). */
  prefetch: number;
  /** FFmpeg `-threads` per job: cpuCount / prefetch (>= 1) so parallel cuts do not starve each other. */
  ffmpegThreads: number;
  sweepIntervalMs: number;
  /** VE2E-90: ffprobe smoothness check of every clip.prepare output (MEDIA_WORKER_SMOOTH_CHECK, default on; 0/false/off disables). A non-smooth stream copy is redone as a re-encode; a non-smooth re-encode only logs a warning. */
  smoothCheck: boolean;
};

export class MediaWorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaWorkerConfigError";
  }
}

const readFlag = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  throw new MediaWorkerConfigError(`${name} must be 0/1/true/false (got "${raw}")`);
};

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
 *   MEDIA_WORKER_MAX_ATTEMPTS (default 2),
 *   MEDIA_WORKER_PREFETCH (default min(3, CPU count), 1..16; always capped at the CPU count so FFmpeg jobs do not starve each other),
 *   MEDIA_WORKER_FFMPEG_THREADS (default floor(CPU count / prefetch), >= 1; 1..64),
 *   MEDIA_WORKER_SMOOTH_CHECK (default 1; VE2E-90 post-cut smoothness check),
 *   MEDIA_WORKER_SWEEP_INTERVAL_MS (default 6h)
 */
export const DEFAULT_MEDIA_WORKER_PREFETCH = 3;

export const loadMediaWorkerConfig = (env: NodeJS.ProcessEnv, repoRoot: string, cpuCount: number = availableParallelism()): MediaWorkerConfig => {
  const cpus = Math.max(1, Math.floor(cpuCount) || 1);
  const prefetch = Math.min(readInt(env, "MEDIA_WORKER_PREFETCH", DEFAULT_MEDIA_WORKER_PREFETCH, 1, 16), cpus);
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
    prefetch,
    ffmpegThreads: readInt(env, "MEDIA_WORKER_FFMPEG_THREADS", Math.max(1, Math.floor(cpus / prefetch)), 1, 64),
    smoothCheck: readFlag(env, "MEDIA_WORKER_SMOOTH_CHECK", true),
    sweepIntervalMs: readInt(env, "MEDIA_WORKER_SWEEP_INTERVAL_MS", 6 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000),
  };
};
