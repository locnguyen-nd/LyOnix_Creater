import { ProviderError, moderateSceneCandidate, type LiveContentKind, type SceneModerationOutcome, type VisionModerationFrame, type VisionModerationSceneContext } from "@lyonix/providers";

/** VE2E-56: the subset of ProviderAccountsService the failover helper needs (kept narrow so it is stub-testable). */
export type ModelFailoverAccounts = {
  acquireContentRequestSlot(accountId: string): Promise<boolean>;
  releaseContentRequestSlot(accountId: string): Promise<void>;
  cooldownContentAccount(accountId: string, retryAfterMs?: number): Promise<unknown>;
  markModelUnusable(accountId: string, modelId: string, reason: string): Promise<void>;
  markModelLimited(accountId: string, modelId: string, retryAfterMs?: number, reason?: string): Promise<Date>;
  getModelAvailability(accountId: string, modelId: string): Promise<{ available: boolean; retryAt: Date | null }>;
};

export type LimitedModel = { accountId: string; modelId: string; retryAt: Date };

export type ModelFailoverResult<T> =
  | { ok: true; value: T; modelId: string; limited: LimitedModel[] }
  | {
      ok: false;
      /** Last ProviderError seen (or the slot-denied error). */
      error: ProviderError | null;
      /** Non-ProviderError thrown by the call (network/timeout): caller decides (existing behaviour: PROVIDER_UNAVAILABLE). */
      thrown?: unknown;
      /** Models benched (already cooling, or limited during this call) with their retry time. */
      limited: LimitedModel[];
      /** The account itself is unusable now (auth, key-level quota/429, slot denied). */
      accountBlocked: boolean;
    };

const dailyCooldownMs = () => {
  const configured = Number(process.env.CONTENT_DAILY_QUOTA_COOLDOWN_MS);
  return Number.isFinite(configured) && configured >= 1_000 ? configured : 15 * 60_000;
};

/** Cooldown for a model-level 429/quota: honours Retry-After/retryDelay; daily quota -> conservative reset (default 60 min); RPM -> 60 s. */
export const modelCooldownMs = (error: ProviderError): number => {
  const daily = error.quotaScope === "daily" || (error.code === "PROVIDER_QUOTA_EXHAUSTED" && error.quotaScope !== "minute");
  if (daily) return Math.max(error.retryAfterMs ?? 0, dailyCooldownMs());
  return error.retryAfterMs ?? 60_000;
};

/** Errors after which the next verified content account (any provider of the same content role) is tried instead of failing the step. */
export const rotatesToNextAccount = (code: string) =>
  code === "PROVIDER_RATE_LIMITED" || code === "PROVIDER_QUOTA_EXHAUSTED" || code === "PROVIDER_AUTH_INVALID" || code === "PROVIDER_CAPABILITY_UNAVAILABLE" || code === "PROVIDER_SCHEMA_INVALID" || code === "PROVIDER_UNAVAILABLE" || code === "PROVIDER_TIMEOUT";

/**
 * Only an explicit key-wide limit (billing / credits) cools the whole account. A quota without a known scope is treated as the
 * model's own (Gemini quotas are per project AND model): benching one model costs at most one more call on the next model,
 * while cooling the account would block every model that still has quota.
 */
export const isKeyLevelLimit = (error: ProviderError) => error.quotaScope === "account";

export const formatRetryAt = (date: Date) => `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;

/** Vietnamese message naming the limited models and the earliest retry time. */
export const describeLimitedModels = (limited: readonly LimitedModel[]): string | null => {
  if (limited.length === 0) return null;
  const earliest = limited.reduce((min, entry) => (entry.retryAt < min ? entry.retryAt : min), limited[0]!.retryAt);
  const names = [...new Set(limited.map((entry) => entry.modelId))].join(", ");
  return `Các model content đang bị giới hạn quota/tốc độ: ${names}. Thử lại sớm nhất lúc ${formatRetryAt(earliest)}.`;
};

const envNumber = (name: string, fallback: number, min: number): number => {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= min ? configured : fallback;
};
/** VE2E-138: model tries per account before moving on (skipped/cooling models do not count). Env `CONTENT_FAILOVER_MAX_MODELS`. */
const maxModelTries = () => Math.floor(envNumber("CONTENT_FAILOVER_MAX_MODELS", 3, 1));
/** VE2E-138: wall-clock budget of one failover walk over an account's models. Env `CONTENT_FAILOVER_DEADLINE_MS` (default 150 s). */
const failoverDeadlineMs = () => envNumber("CONTENT_FAILOVER_DEADLINE_MS", 150_000, 5_000);
/** VE2E-138: a model that answered slower than this (or timed out) is demoted behind every other model of the account. Env `CONTENT_SLOW_MODEL_MS` (default 75 s). */
const slowModelMs = () => envNumber("CONTENT_SLOW_MODEL_MS", 75_000, 1_000);
/** How long a model that timed out stays benched (env `CONTENT_TIMEOUT_BENCH_MS`, default 10 min). */
const timeoutBenchMs = () => envNumber("CONTENT_TIMEOUT_BENCH_MS", 10 * 60_000, 1_000);

const modelLatencyMs = new Map<string, number>();
/** Test hook. */
export const resetModelLatency = () => modelLatencyMs.clear();
/** Last observed latency of a model (ms); a slow one sorts after the fast ones, otherwise the configured rank is kept (stable). */
export const orderByObservedLatency = (accountId: string, models: readonly string[]): string[] => {
  const slow = (modelId: string) => (modelLatencyMs.get(`${accountId}:${modelId}`) ?? 0) > slowModelMs();
  return [...models].sort((a, b) => Number(slow(a)) - Number(slow(b)));
};

const isTimeout = (error: unknown) => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/**
 * VE2E-56: try the ranked `models` of ONE account in order. Skips models in per-model cooldown; a model-level
 * RATE_LIMITED/QUOTA_EXHAUSTED benches only that model and moves to the next model of the same key. Account-level
 * cooldown only for AUTH_INVALID and key-level (billing) limits. The concurrency slot is held for the whole call.
 */
export async function callContentWithModelFailover<T>(
  accounts: ModelFailoverAccounts,
  accountId: string,
  models: readonly string[],
  call: (modelId: string) => Promise<T>,
  options: { markCapabilityUnusable?: boolean } = {},
): Promise<ModelFailoverResult<T>> {
  const limited: LimitedModel[] = [];
  const acquired = await accounts.acquireContentRequestSlot(accountId);
  if (!acquired) {
    return { ok: false, accountBlocked: true, limited, error: new ProviderError("PROVIDER_RATE_LIMITED", "Tài khoản đang trong cooldown hoặc đã đạt concurrency tối đa", true, 1_000) };
  }
  let lastError: ProviderError | null = null;
  const startedAt = Date.now();
  const deadline = startedAt + failoverDeadlineMs();
  let tries = 0;
  try {
    for (const modelId of orderByObservedLatency(accountId, models)) {
      // VE2E-138: bounded walk - a long list of rate-limited free models used to hold one job for 20+ minutes.
      if (tries >= maxModelTries() || (tries > 0 && Date.now() >= deadline)) break;
      const availability = await accounts.getModelAvailability(accountId, modelId).catch(() => ({ available: true, retryAt: null as Date | null }));
      if (!availability.available && availability.retryAt) {
        limited.push({ accountId, modelId, retryAt: availability.retryAt });
        continue;
      }
      tries += 1;
      const callStarted = Date.now();
      try {
        const value = await call(modelId);
        modelLatencyMs.set(`${accountId}:${modelId}`, Date.now() - callStarted);
        return { ok: true, value, modelId, limited };
      } catch (error) {
        if (isTimeout(error)) {
          // A model that does not answer in time is benched and the next model is tried (text generation is idempotent).
          modelLatencyMs.set(`${accountId}:${modelId}`, Math.max(Date.now() - callStarted, slowModelMs() + 1)); // a timeout is slow by definition
          const retryAt = await accounts.markModelLimited(accountId, modelId, timeoutBenchMs(), "PROVIDER_TIMEOUT").catch(() => new Date(Date.now() + timeoutBenchMs()));
          limited.push({ accountId, modelId, retryAt });
          lastError = new ProviderError("PROVIDER_TIMEOUT", "Model không phản hồi kịp thời hạn", true);
          continue;
        }
        if (!(error instanceof ProviderError)) return { ok: false, thrown: error, error: lastError, limited, accountBlocked: false };
        lastError = error;
        if (error.code === "PROVIDER_CAPABILITY_UNAVAILABLE") {
          if (options.markCapabilityUnusable !== false) await accounts.markModelUnusable(accountId, modelId, error.message).catch(() => undefined);
          continue;
        }
        if (error.code === "PROVIDER_SCHEMA_INVALID") continue;
        if (error.code === "PROVIDER_AUTH_INVALID" || ((error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED") && isKeyLevelLimit(error))) {
          const defaultMs = error.code === "PROVIDER_AUTH_INVALID" ? 5 * 60_000 : 15 * 60_000;
          await accounts.cooldownContentAccount(accountId, error.retryAfterMs ?? defaultMs).catch(() => undefined);
          return { ok: false, error, limited, accountBlocked: true };
        }
        if (error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED") {
          const cooldownMs = modelCooldownMs(error);
          const retryAt = await accounts.markModelLimited(accountId, modelId, cooldownMs, error.code).catch(() => new Date(Date.now() + cooldownMs));
          limited.push({ accountId, modelId, retryAt });
          continue;
        }
        return { ok: false, error, limited, accountBlocked: false };
      }
    }
    return { ok: false, error: lastError, limited, accountBlocked: false };
  } finally {
    await accounts.releaseContentRequestSlot(accountId).catch(() => undefined);
  }
}

/** Best-effort vision call using the same cooldown and concurrency gate as script/keywords. A quota error
 * rotates to another discovered model on this key; malformed/unsupported vision evidence stays metadata-only. */
export async function moderateVisionWithModelFailover(
  accounts: ModelFailoverAccounts,
  account: { id: string; provider: LiveContentKind; apiKey: string; models: readonly string[] },
  sceneContext: VisionModerationSceneContext,
  frames: VisionModerationFrame[],
): Promise<{ outcome: SceneModerationOutcome; modelId: string } | null> {
  const result = await callContentWithModelFailover(accounts, account.id, account.models, async (modelId) => {
    const outcome = await moderateSceneCandidate({ kind: account.provider, apiKey: account.apiKey, modelId, operation: "image_moderation", sceneContext, frames });
    if (outcome.failureCode === "PROVIDER_RATE_LIMITED" || outcome.failureCode === "PROVIDER_QUOTA_EXHAUSTED" || outcome.failureCode === "PROVIDER_AUTH_INVALID") {
      throw new ProviderError(outcome.failureCode, "Vision model unavailable", true, outcome.retryAfterMs, outcome.quotaScope);
    }
    return outcome;
  });
  return result.ok ? { outcome: result.value, modelId: result.modelId } : null;
}
