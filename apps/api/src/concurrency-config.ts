/**
 * VE2E-61: one place for every concurrency knob of the API/workflow worker process (env + validation + safe defaults),
 * plus the process-wide provider limiter shared by every job in this process.
 *
 * Env (all optional; an invalid value falls back to the default and is reported in `warnings`, never crashes a run):
 * - WORKFLOW_CONCURRENCY            Auto runs in flight at once (default 5, 1..64; raise only after measuring - see capacity-report)
 * - WORKFLOW_VOICE_PARALLELISM      scenes voiced in parallel inside one run (default 3, 1..8; still bounded by the elevenlabs limiter)
 * - PROVIDER_CONCURRENCY_CONTENT / _APIFY / _PEXELS / _ELEVENLABS / _CREATOMATE
 *                                   max in-flight provider calls across ALL jobs in the process (defaults 3/20/3/2/2, 1..64;
 *                                   set to the provider PLAN's own concurrency cap, never above it; apify default 20 - the Starter plan allows 32 and
 *                                   ApifyService lowers the live cap to GET /v2/users/me/limits maxConcurrentActorJobs when the API reports it)
 * - APIFY_MAX_CONCURRENT_RUNS       Actor runs at once per project:platform inside ApifyService (default 10, 1..64); extra searches WAIT (FIFO)
 * - APIFY_QUEUE_WAIT_TIMEOUT_MS     how long an Apify call may wait for a slot (per-project queue and the shared "apify" limiter) before
 *                                   a retryable PROVIDER_RATE_LIMITED (default 900000 = 15 min, 1000..3600000)
 * - PROVIDER_LIMIT_WAIT_TIMEOUT_MS  max wait in the FIFO queue / cooldown before PROVIDER_RATE_LIMITED (default 120000, 1000..1800000)
 *
 * Honest limit: Creatomate's concurrent-render cap belongs to the account plan; PROVIDER_CONCURRENCY_CREATOMATE only queues on
 * our side and cannot exceed what the plan allows.
 */
import { ProviderLimiter, type ProviderLimiterKey } from "@lyonix/providers";

export const DEFAULT_WORKFLOW_CONCURRENCY = 5;
/** Ceiling only: defaults stay conservative (DEC-2026-10-02-CAPACITY-250 asks 50 concurrent runs; operators opt in via env). */
export const MAX_WORKFLOW_CONCURRENCY = 64;
export const DEFAULT_VOICE_PARALLELISM = 3;
export const MAX_VOICE_PARALLELISM = 8;
export const DEFAULT_PROVIDER_WAIT_TIMEOUT_MS = 120_000;
export const DEFAULT_APIFY_MAX_CONCURRENT_RUNS = 10;
export const DEFAULT_APIFY_QUEUE_WAIT_TIMEOUT_MS = 15 * 60_000;

export const DEFAULT_PROVIDER_LIMITS: Readonly<Record<ProviderLimiterKey, number>> = {
  content: 3,
  apify: 20,
  pexels: 3,
  elevenlabs: 2,
  creatomate: 2,
};
const MAX_PROVIDER_LIMIT = 64;

export type ConcurrencyConfig = {
  workflow: number;
  voiceParallelism: number;
  providerLimits: Record<ProviderLimiterKey, number>;
  providerWaitTimeoutMs: number;
  /** Per project:platform Actor runs in flight (ApifyService). */
  apifyMaxConcurrentRuns: number;
  apifyQueueWaitTimeoutMs: number;
  warnings: string[];
};

type Env = Record<string, string | undefined>;

const readInt = (env: Env, name: string, fallback: number, min: number, max: number, warnings: string[]): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    warnings.push(`${name}="${raw}" is not an integer in [${min}, ${max}]; using ${fallback}`);
    return fallback;
  }
  return value;
};

export const resolveConcurrencyConfig = (env: Env = process.env): ConcurrencyConfig => {
  const warnings: string[] = [];
  const providerLimits = { ...DEFAULT_PROVIDER_LIMITS };
  for (const key of Object.keys(DEFAULT_PROVIDER_LIMITS) as ProviderLimiterKey[]) {
    providerLimits[key] = readInt(env, `PROVIDER_CONCURRENCY_${key.toUpperCase()}`, DEFAULT_PROVIDER_LIMITS[key], 1, MAX_PROVIDER_LIMIT, warnings);
  }
  return {
    workflow: readInt(env, "WORKFLOW_CONCURRENCY", DEFAULT_WORKFLOW_CONCURRENCY, 1, MAX_WORKFLOW_CONCURRENCY, warnings),
    voiceParallelism: readInt(env, "WORKFLOW_VOICE_PARALLELISM", DEFAULT_VOICE_PARALLELISM, 1, MAX_VOICE_PARALLELISM, warnings),
    providerLimits,
    providerWaitTimeoutMs: readInt(env, "PROVIDER_LIMIT_WAIT_TIMEOUT_MS", DEFAULT_PROVIDER_WAIT_TIMEOUT_MS, 1_000, 30 * 60_000, warnings),
    apifyMaxConcurrentRuns: readInt(env, "APIFY_MAX_CONCURRENT_RUNS", DEFAULT_APIFY_MAX_CONCURRENT_RUNS, 1, MAX_PROVIDER_LIMIT, warnings),
    apifyQueueWaitTimeoutMs: readInt(env, "APIFY_QUEUE_WAIT_TIMEOUT_MS", DEFAULT_APIFY_QUEUE_WAIT_TIMEOUT_MS, 1_000, 60 * 60_000, warnings),
    warnings,
  };
};

/** Kept for callers that only need the number of in-flight runs. */
export const resolveWorkflowConcurrency = (env: Env = process.env): number => resolveConcurrencyConfig(env).workflow;

export const createProviderLimiter = (config: ConcurrencyConfig = resolveConcurrencyConfig()): ProviderLimiter =>
  new ProviderLimiter({
    limits: config.providerLimits,
    waitTimeoutMs: config.providerWaitTimeoutMs,
    // VE2E-131: Apify queues for minutes (not an error) and ApifyService holds a slot per Actor call; an outer caller that still wraps a
    // whole flow in run("apify") reuses its slot instead of deadlocking the inner per-call limiter.
    waitTimeoutMsByKey: { apify: Math.max(config.providerWaitTimeoutMs, config.apifyQueueWaitTimeoutMs) },
    reentrantKeys: ["apify"],
    maxCooldownPauseMs: Math.min(30_000, config.providerWaitTimeoutMs),
  });

let shared: ProviderLimiter | null = null;
/** Process-wide limiter: every job of this process queues behind the same per-provider semaphores. */
export const getSharedProviderLimiter = (): ProviderLimiter => (shared ??= createProviderLimiter());
/** Test hook: replace (or reset with null) the shared limiter. */
export const setSharedProviderLimiter = (limiter: ProviderLimiter | null): void => {
  shared = limiter;
};

/**
 * Runs `fn` over `items` with at most `limit` in flight. Results keep item order. After the first failure no new item
 * starts, in-flight ones finish, and the failure of the LOWEST item index is thrown (deterministic, like segment sourcing).
 */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const failed: Array<{ index: number; error: unknown }> = [];
  const worker = async () => {
    for (;;) {
      if (failed.length > 0) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed.push({ index, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => worker()));
  if (failed.length > 0) throw failed.reduce((lowest, entry) => (entry.index < lowest.index ? entry : lowest)).error;
  return results;
}
