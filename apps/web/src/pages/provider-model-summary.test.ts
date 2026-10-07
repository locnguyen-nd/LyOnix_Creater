import { describe, expect, it } from "vitest";
import type { ApiProvider } from "../jobs-api";
import { readyModelCount } from "./provider-model-summary";

const account = (overrides: Partial<ApiProvider> = {}): ApiProvider => ({
  id: "account-1", name: "OpenAI", provider: "openai", role: "content", scope: "personal",
  status: "verified", model: "model-a", visionModel: null, availableModels: ["model-a", "model-b", "model-c"],
  modelSnapshot: [
    { modelId: "model-a", status: "usable", checkedAt: "2026-10-05T00:00:00Z", source: "probed", fresh: true },
    { modelId: "model-b", status: "unverified", checkedAt: "2026-10-05T00:00:00Z", source: "listed", fresh: true },
    { modelId: "model-c", status: "usable", checkedAt: "2026-09-01T00:00:00Z", source: "probed", fresh: false },
  ],
  preferredModels: [], modelCooldowns: [], isFake: false, version: 1,
  ...overrides,
});

describe("readyModelCount", () => {
  it("counts only fresh proven models, not listed or stale models", () => {
    expect(readyModelCount(account())).toBe(1);
  });

  it("excludes cooling down models, removed models, and unverified accounts", () => {
    expect(readyModelCount(account({ modelCooldowns: [{ modelId: "model-a", cooldownUntil: "2026-10-06T00:00:00Z" }] }))).toBe(0);
    expect(readyModelCount(account({ availableModels: ["model-b", "model-c"] }))).toBe(0);
    expect(readyModelCount(account({ status: "failed" }))).toBe(0);
  });
});
