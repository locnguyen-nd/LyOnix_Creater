import { describe, expect, it } from "vitest";
import { assertMutable, isApproved, nextVersionNumber } from "./version-immutability.js";

describe("isApproved / assertMutable", () => {
  it("draft version is mutable", () => {
    expect(isApproved({ approvedAt: null })).toBe(false);
    expect(assertMutable({ approvedAt: null })).toEqual({ ok: true });
  });
  it("approved version must not be mutated in place", () => {
    expect(isApproved({ approvedAt: new Date() })).toBe(true);
    expect(assertMutable({ approvedAt: new Date() })).toEqual({ ok: false, reason: "already_approved" });
  });
});

describe("nextVersionNumber", () => {
  it("starts at 1 when there is no prior version", () => {
    expect(nextVersionNumber(null)).toBe(1);
    expect(nextVersionNumber(undefined)).toBe(1);
  });
  it("increments the current max", () => {
    expect(nextVersionNumber(3)).toBe(4);
  });
});
