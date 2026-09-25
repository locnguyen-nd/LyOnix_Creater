import { describe, expect, it } from "vitest";
import { API_PREFIX, roles } from "./index.js";

describe("contracts", () => {
  it("keeps the API prefix and exactly two roles", () => {
    expect(API_PREFIX).toBe("/api/v1");
    expect(roles).toEqual(["admin", "staff"]);
  });
});
