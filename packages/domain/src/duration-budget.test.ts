import { describe, expect, it } from "vitest";
import { buildDurationBudgetPromptLines, buildNarrationBudget, calibrateCharsPerSecond, checkDurationBand, defaultCharsPerSecond } from "./duration-budget.js";

describe("duration budget", () => {
  it("falls back to language default with little history", () => {
    const r = calibrateCharsPerSecond([{ chars: 40, durationMs: 4000 }], "ja");
    expect(r).toEqual({ charsPerSecond: defaultCharsPerSecond("ja"), sampleCount: 1, source: "default" });
  });
  it("calibrates duration-weighted from history and ignores junk", () => {
    const r = calibrateCharsPerSecond(
      [
        { chars: 70, durationMs: 10000 },
        { chars: 80, durationMs: 10000 },
        { chars: 90, durationMs: 10000 },
        { chars: 0, durationMs: 5000 },
        { chars: 10, durationMs: 100 },
      ],
      "ja",
    );
    expect(r.source).toBe("history");
    expect(r.charsPerSecond).toBe(8);
    expect(r.sampleCount).toBe(3);
  });
  it("rejects absurd history", () => {
    const s = Array.from({ length: 4 }, () => ({ chars: 1, durationMs: 60000 }));
    expect(calibrateCharsPerSecond(s, "vi").source).toBe("default");
  });
  it("builds budget for 60s target", () => {
    const b = buildNarrationBudget({ targetSec: 60, charsPerSecond: 8 });
    expect(b.targetChars).toBe(480);
    expect(b.minChars).toBe(400);
    expect(b.maxChars).toBe(560);
    expect(b.sceneCount.min).toBeGreaterThanOrEqual(7);
    expect(b.sceneCount.max).toBe(30);
    expect(buildDurationBudgetPromptLines(b)).toContain("480 characters");
  });
  it("checks the band inclusively with configurable tolerance", () => {
    expect(checkDurationBand({ targetSec: 60, totalMs: 50000 }).inBand).toBe(true);
    expect(checkDurationBand({ targetSec: 60, totalMs: 70000 }).inBand).toBe(true);
    const low = checkDurationBand({ targetSec: 60, totalMs: 45000 });
    expect(low.inBand).toBe(false);
    expect(low.deviationSec).toBe(-5);
    const high = checkDurationBand({ targetSec: 60, totalMs: 75500 });
    expect(high.deviationSec).toBe(5.5);
    expect(checkDurationBand({ targetSec: 60, totalMs: 64000, toleranceSec: 3 }).inBand).toBe(false);
  });
});
