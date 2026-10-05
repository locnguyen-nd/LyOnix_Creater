import { describe, expect, it } from "vitest";
import { API_PREFIX, roles } from "./index.js";

describe("contracts", () => {
  it("keeps the API prefix and exactly two roles", () => {
    expect(API_PREFIX).toBe("/api/v1");
    expect(roles).toEqual(["admin", "staff"]);
  });
});

describe("VE2E-108 render engine contracts", () => {
  it("lists the three engines and the Router reasons used by the plan", async () => {
    const { renderEngines, renderRouteReasons } = await import("./index.js");
    expect(renderEngines).toEqual(["lyonix", "creatomate", "orshot"]);
    expect(renderRouteReasons).toEqual(expect.arrayContaining(["forced", "default", "fallback_after_error", "budget_exhausted", "template_requires_provider"]));
  });
});
