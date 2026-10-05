import { describe, expect, it } from "vitest";
import { ProviderError } from "./index.js";
import { ProviderLimiter } from "./provider-limiter.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("ProviderLimiter", () => {
  it("never exceeds maxInFlight across concurrent jobs and serves waiters FIFO", async () => {
    const limiter = new ProviderLimiter({ limits: { elevenlabs: 2 }, waitTimeoutMs: 5_000 });
    const gates = Array.from({ length: 6 }, deferred);
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const runs = gates.map((gate, index) =>
      limiter.run("elevenlabs", async () => {
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return index;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.snapshot("elevenlabs")).toMatchObject({ inFlight: 2, queued: 4, limit: 2 });
    for (let i = 0; i < 6; i += 1) {
      gates[i]!.resolve();
      await tick();
    }
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(limiter.snapshot("elevenlabs")).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it("keys are independent", async () => {
    const limiter = new ProviderLimiter({ limits: { apify: 1, pexels: 1 } });
    const gate = deferred();
    const a = limiter.run("apify", () => gate.promise);
    let pexelsRan = false;
    await limiter.run("pexels", async () => { pexelsRan = true; });
    expect(pexelsRan).toBe(true);
    gate.resolve();
    await a;
  });

  it("times out a waiter with retryable PROVIDER_RATE_LIMITED without leaking a slot", async () => {
    const limiter = new ProviderLimiter({ limits: { content: 1 }, waitTimeoutMs: 20 });
    const gate = deferred();
    const holder = limiter.run("content", () => gate.promise);
    await tick();
    const waiting = limiter.run("content", async () => "never");
    await expect(waiting).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
    expect(limiter.snapshot("content")).toMatchObject({ inFlight: 1, queued: 0 });
    gate.resolve();
    await holder;
    expect(await limiter.run("content", async () => "ok")).toBe("ok");
  });

  it("releases the slot when the call throws", async () => {
    const limiter = new ProviderLimiter({ limits: { content: 1 } });
    await expect(limiter.run("content", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await limiter.run("content", async () => 1)).toBe(1);
  });

  it("a provider 429 with retryAfter pauses later callers (bounded) and long cooldowns fail fast", async () => {
    let now = 1_000;
    const limiter = new ProviderLimiter({ limits: { content: 2 }, waitTimeoutMs: 1_000, maxCooldownPauseMs: 50, now: () => now });
    await expect(limiter.run("content", async () => { throw new ProviderError("PROVIDER_RATE_LIMITED", "429", true, 40); })).rejects.toThrow("429");
    expect(limiter.snapshot("content").cooldownMs).toBe(40);
    now += 40; // virtual clock; real pause is the remaining 40ms
    expect(await limiter.run("content", async () => "after")).toBe("after");

    limiter.noteCooldown("content", 5_000);
    await expect(limiter.run("content", async () => "x")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryAfterMs: 5_000 });
  });

  it("honours an external cooldown source (VE2E-56 account/model cooldown)", async () => {
    let cooling = 10_000;
    const limiter = new ProviderLimiter({ externalCooldownMs: (key) => (key === "content" ? cooling : 0), maxCooldownPauseMs: 100 });
    await expect(limiter.run("content", async () => 1)).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    expect(await limiter.run("pexels", async () => 2)).toBe(2);
    cooling = 0;
    expect(await limiter.run("content", async () => 3)).toBe(3);
  });

  it("clamps invalid limits to the default", () => {
    const limiter = new ProviderLimiter({ limits: { apify: 0, pexels: Number.NaN }, defaultMaxInFlight: 3 });
    expect(limiter.limitFor("apify")).toBe(3);
    expect(limiter.limitFor("pexels")).toBe(3);
    expect(limiter.limitFor("unknown")).toBe(3);
  });
});
