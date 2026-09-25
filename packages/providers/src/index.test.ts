import { describe, expect, it } from "vitest";
import { assertRegistrationAllowed, ProviderError, ProviderRegistry, summarizePreflight, type ProviderAccountAdapter } from "./index.js";

const fakeAdapter: ProviderAccountAdapter = {
  async validateConfig() { return { valid: true, capabilities: { capabilities: ["structured_output"], models: ["fake-script"], capturedAt: "2026-09-20T00:00:00Z" } }; },
  async getCapabilities() { return { capabilities: ["structured_output"], models: ["fake-script"], capturedAt: "2026-09-20T00:00:00Z" }; },
};
describe("ProviderRegistry", () => {
  it("catalogues a registered adapter", () => { const registry = new ProviderRegistry(); registry.register({ kind: "fake", role: "content", adapter: fakeAdapter, implementationStatus: "fake" }); expect(registry.resolve("fake", "content").implementationStatus).toBe("fake"); });
  it("does not resolve an unregistered provider role and reports PROVIDER_NOT_CONFIGURED", () => {
    try {
      new ProviderRegistry().resolve("vrew", "render");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("PROVIDER_NOT_CONFIGURED");
    }
  });
});

describe("runtime no-mock invariant", () => {
  it("allows fake registration only when NODE_ENV=test", () => {
    expect(() => assertRegistrationAllowed("fake", "test")).not.toThrow();
    expect(() => assertRegistrationAllowed("fake", "development")).toThrow();
    expect(() => assertRegistrationAllowed("fake", "production")).toThrow();
  });
  it("blocks fake registration when NODE_ENV is unset (defaults closed, not open)", () => {
    expect(() => assertRegistrationAllowed("fake", "")).toThrow();
  });
  it("never blocks non-fake kinds regardless of NODE_ENV", () => {
    expect(() => assertRegistrationAllowed("openai", "production")).not.toThrow();
  });
  it("registry.register accepts a fake adapter inside the vitest test process (NODE_ENV=test)", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register({ kind: "fake", role: "content", adapter: fakeAdapter, implementationStatus: "fake" })).not.toThrow();
  });
});

describe("summarizePreflight", () => {
  it("is not ready when there are no operations", () => {
    expect(summarizePreflight([]).ready).toBe(false);
  });
  it("is ready only when every operation is ready", () => {
    expect(summarizePreflight([{ role: "content", operation: "generate", status: "ready" }]).ready).toBe(true);
    expect(summarizePreflight([
      { role: "content", operation: "generate", status: "ready" },
      { role: "render", operation: "submit", status: "not_configured", code: "PROVIDER_NOT_CONFIGURED" },
    ]).ready).toBe(false);
  });
});
