import { describe, expect, it } from "vitest";
import {
  normalizeBackgroundSegmentBounds,
  parseBackgroundSegmentsSetting,
  readBackgroundSegmentsSetting,
  resolveBackgroundSegmentRange,
} from "./background-segments.js";

describe("parseBackgroundSegmentsSetting", () => {
  it("defaults to auto when absent", () => {
    expect(parseBackgroundSegmentsSetting(undefined)).toEqual({ ok: true, value: { mode: "auto" } });
    expect(parseBackgroundSegmentsSetting(null)).toEqual({ ok: true, value: { mode: "auto" } });
  });

  it("accepts auto and a fixed count inside the placeholder bounds 1..6", () => {
    expect(parseBackgroundSegmentsSetting({ mode: "auto" })).toEqual({ ok: true, value: { mode: "auto" } });
    expect(parseBackgroundSegmentsSetting({ mode: "fixed", count: 1 })).toEqual({ ok: true, value: { mode: "fixed", count: 1 } });
    expect(parseBackgroundSegmentsSetting({ mode: "fixed", count: 6 })).toEqual({ ok: true, value: { mode: "fixed", count: 6 } });
  });

  it("rejects out-of-range, non-integer, missing count, unknown mode and extra fields", () => {
    for (const bad of [{ mode: "fixed", count: 0 }, { mode: "fixed", count: 7 }, { mode: "fixed", count: 2.5 }, { mode: "fixed" }, { mode: "fixed", count: "3" }, { mode: "manual" }, { mode: "auto", count: 3 }, "auto", [], 3]) {
      expect(parseBackgroundSegmentsSetting(bad).ok).toBe(false);
    }
  });

  it("honours configured bounds", () => {
    expect(parseBackgroundSegmentsSetting({ mode: "fixed", count: 8 }, { min: 2, max: 8 }).ok).toBe(true);
    expect(parseBackgroundSegmentsSetting({ mode: "fixed", count: 1 }, { min: 2, max: 8 }).ok).toBe(false);
  });
});

describe("normalizeBackgroundSegmentBounds", () => {
  it("keeps sane bounds and falls back to 1..6 when misconfigured", () => {
    expect(normalizeBackgroundSegmentBounds({ min: 2, max: 8 })).toEqual({ min: 2, max: 8 });
    expect(normalizeBackgroundSegmentBounds({ min: 5, max: 2 })).toEqual({ min: 1, max: 6 });
    expect(normalizeBackgroundSegmentBounds({ min: 0, max: 4 })).toEqual({ min: 1, max: 6 });
    expect(normalizeBackgroundSegmentBounds(undefined)).toEqual({ min: 1, max: 6 });
  });
});

describe("readBackgroundSegmentsSetting", () => {
  it("reads persisted values and treats legacy/garbage as auto", () => {
    expect(readBackgroundSegmentsSetting({ mode: "fixed", count: 4 })).toEqual({ mode: "fixed", count: 4 });
    expect(readBackgroundSegmentsSetting(null)).toEqual({ mode: "auto" });
    expect(readBackgroundSegmentsSetting({ mode: "weird" })).toEqual({ mode: "auto" });
  });
});

describe("resolveBackgroundSegmentRange", () => {
  it("auto: <=30s -> 2..3, >30s -> 3..5, unknown duration -> null", () => {
    expect(resolveBackgroundSegmentRange({ mode: "auto" }, 30)).toEqual({ min: 2, max: 3 });
    expect(resolveBackgroundSegmentRange({ mode: "auto" }, 15)).toEqual({ min: 2, max: 3 });
    expect(resolveBackgroundSegmentRange({ mode: "auto" }, 31)).toEqual({ min: 3, max: 5 });
    expect(resolveBackgroundSegmentRange({ mode: "auto" }, 90)).toEqual({ min: 3, max: 5 });
    expect(resolveBackgroundSegmentRange({ mode: "auto" }, null)).toBeNull();
    expect(resolveBackgroundSegmentRange({ mode: "auto" }, 0)).toBeNull();
  });

  it("fixed: always exactly count, regardless of duration", () => {
    expect(resolveBackgroundSegmentRange({ mode: "fixed", count: 4 }, null)).toEqual({ min: 4, max: 4 });
    expect(resolveBackgroundSegmentRange({ mode: "fixed", count: 1 }, 90)).toEqual({ min: 1, max: 1 });
  });
});
