import { availableParallelism } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_RENDER_QUEUE } from "@lyonix/media-jobs";

export const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"] as const;
export type X264Preset = (typeof X264_PRESETS)[number];

export type ComposeConfig = {
  queue: string;
  /** Parallel renders (AMQP prefetch). Default 1: one 1080p60 encode already uses every core. */
  prefetch: number;
  /** Hard wall-clock limit of one FFmpeg video run. */
  timeoutMs: number;
  x264Preset: X264Preset;
  /** x264/filter threads per render; 0 = FFmpeg decides (all cores). */
  x264Threads: number;
  /** Extra font directory handed to libass (`fontsdir`); null = system fonts only. */
  fontsDir: string | null;
};

export class ComposeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeConfigError";
  }
}

const readInt = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ComposeConfigError(`${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
  return value;
};

/**
 * VE2E-105 env contract (all optional):
 * - MEDIA_WORKER_RENDER_QUEUE (default `lyonix.render`)
 * - MEDIA_WORKER_RENDER_PREFETCH (default 1, 1..4, never above the CPU count)
 * - RENDER_X264_PRESET (default `faster`), RENDER_X264_THREADS (default 0 = auto, 0..64)
 * - RENDER_JOB_TIMEOUT_MS (default 15 min, 10 s..2 h)
 * - RENDER_FONTS_DIR (extra fonts directory for libass; relative paths resolve against the repo root)
 */
export const loadComposeConfig = (env: NodeJS.ProcessEnv, repoRoot: string, cpuCount: number = availableParallelism()): ComposeConfig => {
  const preset = (env.RENDER_X264_PRESET?.trim() || "faster") as X264Preset;
  if (!(X264_PRESETS as readonly string[]).includes(preset)) throw new ComposeConfigError(`RENDER_X264_PRESET must be one of ${X264_PRESETS.join("|")} (got "${preset}")`);
  const fontsRaw = env.RENDER_FONTS_DIR?.trim();
  return {
    queue: env.MEDIA_WORKER_RENDER_QUEUE?.trim() || DEFAULT_RENDER_QUEUE,
    prefetch: Math.min(readInt(env, "MEDIA_WORKER_RENDER_PREFETCH", 1, 1, 4), Math.max(1, Math.floor(cpuCount) || 1)),
    timeoutMs: readInt(env, "RENDER_JOB_TIMEOUT_MS", 15 * 60_000, 10_000, 2 * 60 * 60_000),
    x264Preset: preset,
    x264Threads: readInt(env, "RENDER_X264_THREADS", 0, 0, 64),
    fontsDir: fontsRaw ? (isAbsolute(fontsRaw) ? fontsRaw : resolve(repoRoot, fontsRaw)) : null,
  };
};
