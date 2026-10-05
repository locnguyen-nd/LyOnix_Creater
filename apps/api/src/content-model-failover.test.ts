import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@lyonix/providers";
import { callContentWithModelFailover, describeLimitedModels } from "./content-model-failover.js";

const accounts = () => ({
  acquireContentRequestSlot: vi.fn(async () => true),
  releaseContentRequestSlot: vi.fn(async () => undefined),
  cooldownContentAccount: vi.fn(async () => new Date()),
  markModelUnusable: vi.fn(async () => undefined),
  markModelLimited: vi.fn(async () => new Date("2026-10-01T12:00:00Z")),
  getModelAvailability: vi.fn(async (_accountId: string, _modelId: string) => ({ available: true, retryAt: null as Date | null })),
});

describe("content model failover", () => {
  it("rotates models on the same account while holding one concurrency slot", async () => {
    const gate = accounts();
    const call = vi.fn(async (modelId: string) => {
      if (modelId === "a") throw new ProviderError("PROVIDER_RATE_LIMITED", "per minute", true, 30_000, "minute");
      return modelId;
    });
    const result = await callContentWithModelFailover(gate, "account", ["a", "b"], call);
    expect(result).toMatchObject({ ok: true, value: "b", modelId: "b" });
    expect(call).toHaveBeenCalledTimes(2);
    expect(gate.acquireContentRequestSlot).toHaveBeenCalledTimes(1);
    expect(gate.releaseContentRequestSlot).toHaveBeenCalledTimes(1);
    expect(gate.markModelLimited).toHaveBeenCalledWith("account", "a", 30_000, "PROVIDER_RATE_LIMITED");
    expect(gate.cooldownContentAccount).not.toHaveBeenCalled();
  });

  it("names every limited model and earliest retry when none can run", async () => {
    const gate = accounts();
    gate.getModelAvailability.mockImplementation(async (_accountId, modelId) => ({ available: false, retryAt: new Date(modelId === "a" ? "2026-10-01T13:00:00Z" : "2026-10-01T12:00:00Z") }));
    const call = vi.fn();
    const result = await callContentWithModelFailover(gate, "account", ["a", "b"], call);
    expect(result.ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
    expect(describeLimitedModels(result.limited)).toContain("2026-10-01 12:00:00 UTC");
    expect(describeLimitedModels(result.limited)).toContain("a, b");
    expect(gate.releaseContentRequestSlot).toHaveBeenCalledTimes(1);
  });

  it("keeps auth failure at account scope", async () => {
    const gate = accounts();
    const call = vi.fn(async () => { throw new ProviderError("PROVIDER_AUTH_INVALID", "bad key", false); });
    const result = await callContentWithModelFailover(gate, "account", ["a", "b"], call);
    expect(result).toMatchObject({ ok: false, accountBlocked: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(gate.cooldownContentAccount).toHaveBeenCalledTimes(1);
    expect(gate.markModelLimited).not.toHaveBeenCalled();
  });
});
