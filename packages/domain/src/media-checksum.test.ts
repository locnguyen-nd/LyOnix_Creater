import { describe, expect, it } from "vitest";
import { findDuplicateReusableAsset, isSha256Hex } from "./media-checksum.js";

const CHECKSUM = "a".repeat(64);

describe("findDuplicateReusableAsset", () => {
  it("returns the existing reusable asset with the same checksum", () => {
    const existing = [{ id: "a1", checksumSha256: CHECKSUM, reusable: true }];
    expect(findDuplicateReusableAsset(CHECKSUM, existing)?.id).toBe("a1");
  });
  it("ignores non-reusable and soft-deleted matches", () => {
    const existing = [
      { id: "a1", checksumSha256: CHECKSUM, reusable: false },
      { id: "a2", checksumSha256: CHECKSUM, reusable: true, deletedAt: new Date() },
    ];
    expect(findDuplicateReusableAsset(CHECKSUM, existing)).toBeNull();
  });
  it("returns null when no checksum matches", () => {
    const existing = [{ id: "a1", checksumSha256: "b".repeat(64), reusable: true }];
    expect(findDuplicateReusableAsset(CHECKSUM, existing)).toBeNull();
  });
});

describe("isSha256Hex", () => {
  it("accepts a 64-char hex digest", () => {
    expect(isSha256Hex(CHECKSUM)).toBe(true);
  });
  it("rejects wrong length or non-hex", () => {
    expect(isSha256Hex("abc")).toBe(false);
    expect(isSha256Hex("z".repeat(64))).toBe(false);
  });
});
