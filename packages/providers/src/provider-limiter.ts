/**
 * VE2E-61: in-process limiter shared ACROSS jobs (one semaphore per provider key). Callers that exceed
 * `maxInFlight` wait in a FIFO queue instead of failing; a waiter that cannot get a slot within
 * `waitTimeoutMs` gets a retryable `PROVIDER_RATE_LIMITED` (the run's bounded retry re-queues it, resuming in place).
 * A provider-reported 429 (`ProviderError` PROVIDER_RATE_LIMITED/PROVIDER_QUOTA_EXHAUSTED with `retryAfterMs`) opens a
 * short cooldown window for that key so queued callers pause instead of hammering the provider; an external cooldown
 * source (VE2E-56/57 account/model cooldown) can be plugged in through `externalCooldownMs`.
 *
 * This is a per-process guard (api worker / one process). It does not replace the Postgres-shared account gates
 * (`acquireContentRequestSlot`); it sits in front of them so waiting is cheap and ordered.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ProviderError } from "./index.js";

export type ProviderLimiterKey = "content" | "apify" | "pexels" | "elevenlabs" | "creatomate";
export const providerLimiterKeys: readonly ProviderLimiterKey[] = ["content", "apify", "pexels", "elevenlabs", "creatomate"];

export type ProviderLimiterOptions = {
  /** Max in-flight calls per key. Keys absent here use `defaultMaxInFlight`. Values are floored and clamped to >= 1. */
  limits?: Readonly<Record<string, number>>;
  defaultMaxInFlight?: number;
  /** Max time a caller waits (queue + cooldown) before PROVIDER_RATE_LIMITED. */
  waitTimeoutMs?: number;
  /** VE2E-131: per-key override of `waitTimeoutMs` (e.g. Apify queues for minutes instead of failing after 2). */
  waitTimeoutMsByKey?: Readonly<Record<string, number>>;
  /**
   * VE2E-131: keys whose `run` is re-entrant. A nested `run(key)` made while the same async chain already holds a slot of `key`
   * reuses that slot instead of queueing again (an outer caller wrapping a whole flow cannot deadlock the inner per-call limiter).
   */
  reentrantKeys?: readonly string[];
  /** Longest pause honoured after a provider 429 (longer retry-after values only pause this long). */
  maxCooldownPauseMs?: number;
  /** Optional external cooldown (ms remaining, 0/null when none) for a key, e.g. DB account/model cooldown from VE2E-56. */
  externalCooldownMs?: (key: string) => number | null | undefined;
  now?: () => number;
};

export type ProviderLimiterSnapshot = { key: string; inFlight: number; queued: number; limit: number; cooldownMs: number };

type Waiter = { grant: () => void; cancel: () => void };

type KeyState = { inFlight: number; queue: Waiter[]; cooldownUntil: number };

const clampLimit = (value: number | undefined, fallback: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};

export class ProviderLimiter {
  private readonly states = new Map<string, KeyState>();
  private readonly limits: Record<string, number>;
  private readonly defaultMax: number;
  private readonly waitTimeoutMs: number;
  private readonly maxCooldownPauseMs: number;
  private readonly now: () => number;
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(private readonly options: ProviderLimiterOptions = {}) {
    this.defaultMax = clampLimit(options.defaultMaxInFlight, 2);
    this.limits = { ...(options.limits ?? {}) };
    this.waitTimeoutMs = Math.max(1, options.waitTimeoutMs ?? 120_000);
    this.maxCooldownPauseMs = Math.max(0, options.maxCooldownPauseMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  /** VE2E-131: change the cap of one key at runtime (e.g. lowered to the Apify plan's real concurrency). Raising only affects later arrivals. */
  setLimit(key: string, limit: number): void {
    this.limits[key] = clampLimit(limit, this.limitFor(key));
  }

  limitFor(key: string): number {
    return clampLimit(this.limits[key], this.defaultMax);
  }

  snapshot(key: string): ProviderLimiterSnapshot {
    const state = this.state(key);
    return { key, inFlight: state.inFlight, queued: state.queue.length, limit: this.limitFor(key), cooldownMs: this.cooldownRemaining(key) };
  }

  /** Records a cooldown window for `key` (ms from now), e.g. after a provider 429. */
  noteCooldown(key: string, retryAfterMs: number): void {
    const state = this.state(key);
    state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + Math.max(0, retryAfterMs));
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const heldNow = this.held.getStore();
    if (heldNow?.has(key) && this.options.reentrantKeys?.includes(key)) return fn();
    await this.acquire(key);
    try {
      return await this.held.run(new Set([...(heldNow ?? []), key]), fn);
    } catch (error) {
      if (error instanceof ProviderError && (error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED") && error.retryAfterMs) {
        this.noteCooldown(key, error.retryAfterMs);
      }
      throw error;
    } finally {
      this.release(key);
    }
  }

  private state(key: string): KeyState {
    let state = this.states.get(key);
    if (!state) {
      state = { inFlight: 0, queue: [], cooldownUntil: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private cooldownRemaining(key: string): number {
    const own = Math.max(0, this.state(key).cooldownUntil - this.now());
    const external = Math.max(0, Number(this.options.externalCooldownMs?.(key) ?? 0) || 0);
    return Math.max(own, external);
  }

  private timeoutError(key: string, retryAfterMs?: number): ProviderError {
    return new ProviderError("PROVIDER_RATE_LIMITED", `Hàng đợi provider "${key}" đầy hoặc đang trong cooldown; thử lại sau`, true, retryAfterMs ?? 5_000);
  }

  private async acquire(key: string): Promise<void> {
    const deadline = this.now() + (this.options.waitTimeoutMsByKey?.[key] ?? this.waitTimeoutMs);
    // 1) Honour a cooldown window first (bounded by the wait timeout; a longer cooldown fails fast with its remaining time).
    for (;;) {
      const remaining = this.cooldownRemaining(key);
      if (remaining <= 0) break;
      if (remaining > this.maxCooldownPauseMs || this.now() + remaining > deadline) throw this.timeoutError(key, remaining);
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
    // 2) FIFO slot. A free slot is only taken directly when nobody is queued ahead.
    const state = this.state(key);
    if (state.inFlight < this.limitFor(key) && state.queue.length === 0) {
      state.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve();
        },
        cancel: () => undefined,
      };
      const timer = setTimeout(() => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        reject(this.timeoutError(key));
      }, Math.max(1, deadline - this.now()));
      state.queue.push(waiter);
    });
  }

  private release(key: string): void {
    const state = this.state(key);
    // Slot handoff keeps inFlight constant when a waiter is granted (strict FIFO, no barging).
    const next = state.queue.length > 0 && state.inFlight <= this.limitFor(key) ? state.queue.shift() : undefined;
    if (next) {
      next.grant();
      return;
    }
    state.inFlight = Math.max(0, state.inFlight - 1);
  }
}
