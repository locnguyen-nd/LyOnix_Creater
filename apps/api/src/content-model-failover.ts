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

export const isKeyLevelLimit = (error: ProviderError) => error.quotaScope === "account" || error.quotaScope === undefined;

export const formatRetryAt = (date: Date) => `${date.toISOString().replace("T", " ").slice(0, 19)} UTC`;

/** Vietnamese message naming the limited models and the earliest retry time. */
export const describeLimitedModels = (limited: readonly LimitedModel[]): string | null => {
  if (limited.length === 0) return null;
  const earliest = limited.reduce((min, entry) => (entry.retryAt < min ? entry.retryAt : min), limited[0]!.retryAt);
  const names = [...new Set(limited.map((entry) => entry.modelId))].join(", ");
  return `Các model content đang bị giới hạn quota/tốc độ: ${names}. Thử lại sớm nhất lúc ${formatRetryAt(earliest)}.`;
};

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
  try {
    for (const modelId of models) {
      const availability = await accounts.getModelAvailability(accountId, modelId).catch(() => ({ available: true, retryAt: null as Date | null }));
      if (!availability.available && availability.retryAt) {
        limited.push({ accountId, modelId, retryAt: availability.retryAt });
        continue;
      }
      try {
        const value = await call(modelId);
        return { ok: true, value, modelId, limited };
      } catch (error) {
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
