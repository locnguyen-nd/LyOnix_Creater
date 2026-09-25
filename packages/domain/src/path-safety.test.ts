import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeRelativePath, isSafeSegmentName, resolveWithinRoot } from "./path-safety.js";

describe("isSafeRelativePath", () => {
  it("accepts a clean nested relative path", () => {
    expect(isSafeRelativePath("projects/abc/asset-1.png")).toBe(true);
  });
  it("rejects traversal", () => {
    expect(isSafeRelativePath("../secrets/.env")).toBe(false);
    expect(isSafeRelativePath("projects/../../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("a/b/../../../c")).toBe(false);
  });
  it("rejects absolute posix and windows paths", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\System32")).toBe(false);
  });
  it("rejects null bytes and home-relative paths", () => {
    expect(isSafeRelativePath("a\0b")).toBe(false);
    expect(isSafeRelativePath("~/secrets")).toBe(false);
  });
});

describe("isSafeSegmentName", () => {
  it("accepts a normal folder name", () => {
    expect(isSafeSegmentName("Scenes v2")).toBe(true);
  });
  it("rejects separators and dot segments", () => {
    expect(isSafeSegmentName("a/b")).toBe(false);
    expect(isSafeSegmentName("..")).toBe(false);
    expect(isSafeSegmentName(".")).toBe(false);
    expect(isSafeSegmentName("")).toBe(false);
  });
});

describe("resolveWithinRoot", () => {
  const root = resolve("/data/media");
  it("resolves a safe relative path inside root", () => {
    const result = resolveWithinRoot(root, "projects/p1/a.png", resolve, relative);
    expect(result.ok).toBe(true);
  });
  it("rejects a traversal attempt even if resolveFn would escape root", () => {
    const result = resolveWithinRoot(root, "../../etc/passwd", resolve, relative);
    expect(result).toEqual({ ok: false, reason: "unsafe_relative_path" });
  });
});
