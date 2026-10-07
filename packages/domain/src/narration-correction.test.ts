import { describe, expect, it } from "vitest";
import { buildNarrationBudget, narrationLengthCorrection } from "./duration-budget.js";

const budget = buildNarrationBudget({ targetSec: 78, charsPerSecond: 6.4 });
const scene = (chars: number) => "あ".repeat(chars);

describe("narrationLengthCorrection", () => {
  it("asks for a longer rewrite when the voice would be ~28 s for a 78 s target", () => {
    const result = narrationLengthCorrection(budget, Array.from({ length: 9 }, () => scene(20)));
    expect(result).not.toBeNull();
    expect(result!.totalChars).toBe(180);
    expect(result!.direction).toContain("longer");
    expect(result!.direction).toContain(String(budget.minChars));
  });
  it("accepts a draft inside (or near) the band", () => {
    expect(narrationLengthCorrection(budget, Array.from({ length: 9 }, () => scene(Math.round(budget.targetChars / 9))))).toBeNull();
    expect(narrationLengthCorrection(budget, Array.from({ length: 9 }, () => scene(Math.round(budget.minChars / 9) - 2)))).toBeNull();
  });
  it("asks for a shorter rewrite when far too long", () => {
    expect(narrationLengthCorrection(budget, [scene(budget.maxChars * 2)])!.direction).toContain("shorter");
  });
});
