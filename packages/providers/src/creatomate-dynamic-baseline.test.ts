import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creatomateBaselineCases, type CreatomateBaselineCase } from "./creatomate-dynamic-baseline.cases.js";

/** VE2E-93: a timeline without any VE2E-93 caption style key sends Creatomate exactly the same `source` as before VE2E-93. */
const baseline = JSON.parse(readFileSync(new URL("./fixtures/creatomate-dynamic-baseline.json", import.meta.url), "utf8")) as CreatomateBaselineCase[];

describe("VE2E-93 Creatomate dynamic composition regression (no new style keys)", () => {
  const current = creatomateBaselineCases();
  it("covers the same cases as the captured baseline", () => {
    expect(current.map((c) => c.name)).toEqual(baseline.map((c) => c.name));
  });
  it.each(baseline.map((c) => [c.name, c] as const))("%s is identical", (name, expected) => {
    expect(JSON.stringify(current.find((c) => c.name === name))).toBe(JSON.stringify(expected));
  });
});
