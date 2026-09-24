import { describe, expect, it } from "vitest";
import { ProviderError, ProviderRegistry, type ProviderAccountAdapter } from "./index.js";

const fakeAdapter: ProviderAccountAdapter = {
  async validateConfig() { return { valid: true, capabilities: { capabilities: ["structured_output"], models: ["fake-script"], capturedAt: "2026-09-20T00:00:00Z" } }; },
  async getCapabilities() { return { capabilities: ["structured_output"], models: ["fake-script"], capturedAt: "2026-09-20T00:00:00Z" }; },
};
describe("ProviderRegistry", () => {
  it("catalogues a registered adapter", () => { const registry = new ProviderRegistry(); registry.register({ kind: "fake", role: "content", adapter: fakeAdapter, implementationStatus: "fake" }); expect(registry.resolve("fake", "content").implementationStatus).toBe("fake"); });
  it("does not resolve an unregistered provider role", () => { expect(() => new ProviderRegistry().resolve("vrew", "render")).toThrow(ProviderError); });
});
