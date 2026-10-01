import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_LIMITS, createProviderLimiter, getSharedProviderLimiter, mapBounded, resolveConcurrencyConfig, resolveWorkflowConcurrency, setSharedProviderLimiter } from "./concurrency-config.js";

describe("resolveConcurrencyConfig", () => {
  it("has safe defaults and no warnings", () => {
    const config = resolveConcurrencyConfig({});
    expect(config).toMatchObject({ workflow: 5, voiceParallelism: 3, providerWaitTimeoutMs: 120_000, providerLimits: DEFAULT_PROVIDER_LIMITS, warnings: [] });
  });

  it("reads overrides", () => {
    const config = resolveConcurrencyConfig({ WORKFLOW_CONCURRENCY: "8", WORKFLOW_VOICE_PARALLELISM: "2", PROVIDER_CONCURRENCY_ELEVENLABS: "5", PROVIDER_CONCURRENCY_CREATOMATE: "1", PROVIDER_LIMIT_WAIT_TIMEOUT_MS: "5000" });
    expect(config).toMatchObject({ workflow: 8, voiceParallelism: 2, providerWaitTimeoutMs: 5000 });
    expect(config.providerLimits).toMatchObject({ elevenlabs: 5, creatomate: 1, content: 3 });
  });

  it("falls back to defaults on invalid values and reports them", () => {
    const config = resolveConcurrencyConfig({ WORKFLOW_CONCURRENCY: "99", WORKFLOW_VOICE_PARALLELISM: "abc", PROVIDER_CONCURRENCY_APIFY: "0", PROVIDER_LIMIT_WAIT_TIMEOUT_MS: "5" });
    expect(config).toMatchObject({ workflow: 5, voiceParallelism: 3, providerWaitTimeoutMs: 120_000 });
    expect(config.providerLimits.apify).toBe(3);
    expect(config.warnings).toHaveLength(4);
    expect(resolveWorkflowConcurrency({ WORKFLOW_CONCURRENCY: "10" })).toBe(10);
  });

  it("builds the limiter from config and exposes a replaceable shared instance", () => {
    const limiter = createProviderLimiter(resolveConcurrencyConfig({ PROVIDER_CONCURRENCY_PEXELS: "7" }));
    expect(limiter.limitFor("pexels")).toBe(7);
    expect(limiter.limitFor("elevenlabs")).toBe(2);
    setSharedProviderLimiter(limiter);
    expect(getSharedProviderLimiter()).toBe(limiter);
    setSharedProviderLimiter(null);
  });
});

describe("mapBounded", () => {
  it("keeps order, respects the limit, and throws the lowest-index failure after in-flight work finishes", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapBounded([1, 2, 3, 4, 5], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
    const started: number[] = [];
    await expect(
      mapBounded([1, 2, 3, 4], 2, async (n) => {
        started.push(n);
        await new Promise((r) => setTimeout(r, n === 2 ? 1 : 10));
        if (n <= 2) throw new Error(`fail-${n}`);
        return n;
      }),
    ).rejects.toThrow("fail-1");
    expect(started.length).toBeLessThan(4);
  });

  it("handles empty input", async () => {
    expect(await mapBounded([], 3, async () => 1)).toEqual([]);
  });
});
