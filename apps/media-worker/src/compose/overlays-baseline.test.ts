import { readFileSync } from "node:fs";
import { RELEASED_RECIPES } from "@lyonix/render-recipes";
import { describe, expect, it } from "vitest";
import { overlayBaselineCases, type OverlayBaselineCase } from "./overlays-baseline.cases.js";

/**
 * VE2E-93: a timeline without any VE2E-93 caption style key burns in exactly the same ASS as before VE2E-93 (all released recipes).
 *
 * The one intentional change (spec D3): a VE2E-26 fill colour on a recipe with a per-scene `colorCycle` used to be silently overridden by
 * the cycle colours (`{\1c...}` on every event); the user's colour now wins, so those events lose the cycle tag and nothing else changes.
 */
const baseline = JSON.parse(readFileSync(new URL("./fixtures/overlays-baseline.json", import.meta.url), "utf8")) as OverlayBaselineCase[];

/**
 * VE2E-157 (`compose.v2`): the only change to these documents is the motion of the shared preset - an entrance block (`\fad` + optional pop),
 * `\move` instead of `\pos` for a rising layer, and a layer event that starts at its entrance delay. Stripping exactly that must give back the
 * pre-v2 bytes (line breaks, font sizes, styles, cue timing unchanged).
 */
const ENTRANCE_BLOCK = /\{\\fad\(\d+,\d+\)(?:\\fscx\d+\\fscy\d+\\t\(0,\d+,\\fscx100\\fscy100\))?\}/g;
const stripCaptionMotion = (ass: string | null): string | null => (ass === null ? null : ass.replace(ENTRANCE_BLOCK, ""));
const stripLayerMotion = (ass: string): string =>
  ass.replace(ENTRANCE_BLOCK, "").replace(/\\move\(-?\d+,-?\d+,(-?\d+),(-?\d+),0,\d+\)/g, "\\pos($1,$2)").replace(/^(Dialogue: 0,)\d+:\d{2}:\d{2}\.\d{2},/m, "$10:00:00.00,");
const withoutMotion = (c: OverlayBaselineCase): OverlayBaselineCase => ({ ...c, captions: stripCaptionMotion(c.captions), layers: c.layers.map(stripLayerMotion) });

const CYCLE_RECIPES = new Set(RELEASED_RECIPES.filter((recipe) => recipe.captions.colorCycle?.length).map((recipe) => `${recipe.id}@${recipe.version}`));
const isUserColourOverCycle = (name: string) => name.includes("/legacyFontColor/") && CYCLE_RECIPES.has(name.split("/")[0]!);

describe("VE2E-93 overlay regression (no new style keys)", () => {
  const current = overlayBaselineCases();
  it("covers the same cases as the captured baseline", () => {
    expect(current.map((c) => c.name)).toEqual(baseline.map((c) => c.name));
    expect(baseline.filter((c) => isUserColourOverCycle(c.name))).toHaveLength(6);
  });

  it.each(baseline.filter((c) => !isUserColourOverCycle(c.name)).map((c) => [c.name, c] as const))("%s is byte-identical (motion tags aside)", (name, expected) => {
    expect(withoutMotion(current.find((c) => c.name === name)!)).toEqual(expected);
  });

  it("every caption event and every text layer of a released recipe does carry the motion (nothing is left static)", () => {
    for (const c of current.filter((entry) => !entry.name.startsWith("test-"))) {
      for (const line of (c.captions ?? "").split("\n").filter((l) => l.startsWith("Dialogue:"))) expect(line, c.name).toMatch(ENTRANCE_BLOCK);
      for (const layer of c.layers) expect(layer, c.name).toMatch(/\\fad\(\d+,\d+\)/);
    }
  });

  it.each(baseline.filter((c) => isUserColourOverCycle(c.name)).map((c) => [c.name, c] as const))("%s: the user's colour wins over the colour cycle (D3)", (name, expected) => {
    const actual = withoutMotion(current.find((c) => c.name === name)!);
    expect(expected.captions).toMatch(/\{\\1c&H[0-9A-F]{6}&\}/);
    expect(actual.captions).not.toMatch(/\\1c/);
    expect(actual.captions).toBe(expected.captions!.replace(/\{\\1c&H[0-9A-F]{6}&\}/g, ""));
    expect(actual.captions).toContain("&H0000FF00"); // the user's green as the style colour
    expect(actual.layers).toEqual(expected.layers);
  });
});
