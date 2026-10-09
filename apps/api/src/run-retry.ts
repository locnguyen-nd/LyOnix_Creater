/**
 * Render reliability: when an Auto run failed on something transient (rate limit, quota, provider down) it is re-queued, but no
 * earlier than the provider allows. The wait is the provider's own Retry-After / retryDelay / cooldown when it gave one, else a
 * bounded exponential backoff. A wait longer than {@link MAX_AUTO_RETRY_WAIT_MS} (e.g. a daily quota that resets tomorrow) is not
 * waited out silently: the run fails with the time it can be retried, instead of sitting in the queue for hours.
 */
export const RETRY_BASE_MS = 20_000;
export const RETRY_MAX_BACKOFF_MS = 5 * 60_000;
export const MAX_AUTO_RETRY_WAIT_MS = 30 * 60_000;
/** Never re-queue sooner than this, even when the provider said "retry in 0.2 s". */
export const MIN_RETRY_WAIT_MS = 2_000;

export type RunRetryPlan = { retry: true; waitMs: number; notBefore: Date } | { retry: false; waitMs: number; retryAt: Date };

/** `attempt` = the attempt that just failed (1 = first try). `retryAfterMs` = what the provider / cooldown asked for, if anything. */
export function planRunRetry(input: { attempt: number; retryAfterMs?: number | null; now: Date }): RunRetryPlan {
  const backoff = Math.min(RETRY_MAX_BACKOFF_MS, RETRY_BASE_MS * 2 ** Math.max(0, input.attempt - 1));
  const asked = typeof input.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs) && input.retryAfterMs > 0 ? input.retryAfterMs : null;
  const waitMs = Math.max(MIN_RETRY_WAIT_MS, asked ?? backoff);
  const at = new Date(input.now.getTime() + waitMs);
  return waitMs <= MAX_AUTO_RETRY_WAIT_MS ? { retry: true, waitMs, notBefore: at } : { retry: false, waitMs, retryAt: at };
}

/** Milliseconds until an ISO time (null when absent, unparsable or already past). */
export function msUntil(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at > now.getTime() ? at - now.getTime() : null;
}

export const formatRetryClock = (date: Date) => `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
