import { describe, expect, it } from "vitest";
import { computeExpiresAt, isExpired, isRetentionExempt } from "./media-retention.js";

describe("computeExpiresAt", () => {
  it("returns null (no TTL) for reusable project assets", () => {
    expect(computeExpiresAt("project")).toBeNull();
  });
  it("returns now+7d for working derivatives", () => {
    const now = new Date("2026-09-24T00:00:00.000Z");
    const expires = computeExpiresAt("working", now);
    expect(expires?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("isExpired", () => {
  it("null expiresAt is never expired", () => {
    expect(isExpired(null)).toBe(false);
  });
  it("past expiresAt is expired", () => {
    expect(isExpired(new Date("2020-01-01"), new Date("2026-01-01"))).toBe(true);
  });
});

describe("isRetentionExempt", () => {
  it("project + reusable is exempt from TTL sweep", () => {
    expect(isRetentionExempt({ retentionClass: "project", reusable: true })).toBe(true);
  });
  it("working is never exempt", () => {
    expect(isRetentionExempt({ retentionClass: "working", reusable: true })).toBe(false);
  });
  it("project but not reusable is not exempt", () => {
    expect(isRetentionExempt({ retentionClass: "project", reusable: false })).toBe(false);
  });
});
