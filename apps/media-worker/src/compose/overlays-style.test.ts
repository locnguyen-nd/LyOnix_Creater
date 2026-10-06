import { describe, expect, it } from "vitest";
import { buildOverlayDocuments, captionFontsForPlan } from "./overlays.js";
import { makePlan, testRecipe, type FixtureFiles } from "./test-fixtures.js";

/** VE2E-93: the LyOnix burned-in captions follow the whole-video style (`plan.params`) and each scene's own style (`captionParams`). */

const files: FixtureFiles = { image: "a.jpg", landscape: "b.mp4", portraitShort: "c.mp4", voices: ["v0.mp3", "v1.mp3", "v2.mp3"], music: "m.wav" };
const recipe = testRecipe("Noto Sans CJK JP");
const plan = (params: Record<string, string> = {}) => makePlan(files, { texts: ["一つ目の字幕", "二つ目の字幕", "三つ目の字幕"], params });

const stylesOf = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Style: ")).map((line) => line.split(","));
const eventsOf = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue: "));

describe("VE2E-93 LyOnix caption style", () => {
  it("(22) applies the whole-video size, colour, stroke, position, lines and highlight to the Sub style", () => {
    const params = {
      "dynamicStyle.captionFontId": "noto-sans-jp",
      "dynamicStyle.captionFontSizePx": "90",
      "dynamicStyle.captionFillColor": "#FF0000",
      "dynamicStyle.captionStrokeColor": "#0000FF",
      "dynamicStyle.captionStrokeWidthPx": "12",
      "dynamicStyle.captionPosition": "middle",
      "dynamicStyle.captionMaxLines": "1",
      "dynamicStyle.captionAnimation": "none",
    };
    const ass = buildOverlayDocuments(plan(params), recipe, params).captions!.ass;
    const [sub, ...others] = stylesOf(ass);
    expect(others).toEqual([]);
    expect(sub!.slice(0, 6)).toEqual(["Style: Sub", "Noto Sans CJK JP", "90", "&H000000FF", "&H000000FF", "&H00FF0000"]); // red text, blue outline
    expect(sub![16]).toBe("12"); // outline px
    expect(sub![18]).toBe("5"); // middle
    expect(eventsOf(ass).every((event) => !event.includes("\\k") && !event.includes("\\N"))).toBe(true); // no highlight, one line
  });

  it("(9) a disabled stroke draws no outline", () => {
    const params = { "dynamicStyle.captionStrokeEnabled": "false" };
    expect(stylesOf(buildOverlayDocuments(plan(params), recipe, params).captions!.ass)[0]![16]).toBe("0");
  });

  it("(2, 22) a scene with its own style gets its own ASS style; the other scenes keep Sub", () => {
    const p = plan({ "dynamicStyle.captionFontSizePx": "80" });
    p.scenes[1]!.captionParams = { "dynamicStyle.captionFillColor": "#00FF00", "dynamicStyle.captionPosition": "top" };
    const ass = buildOverlayDocuments(p, recipe, p.params).captions!.ass;
    const styles = stylesOf(ass);
    expect(styles.map((style) => style[0])).toEqual(["Style: Sub", "Style: Sub2"]);
    expect(styles[1]![2]).toBe("80"); // inherits the whole-video size
    expect(styles[1]![4]).toBe("&H0000FF00"); // its own (unspoken) colour
    expect(styles[1]![18]).toBe("8"); // top
    expect(eventsOf(ass).map((event) => event.split(",")[3])).toEqual(["Sub", "Sub2", "Sub"]);
  });

  it("(D3) a fill colour set by the user wins over the recipe colour cycle, per scene", () => {
    const cycling = { ...recipe, captions: { ...recipe.captions, highlight: "none" as const, colorCycle: ["#FFFFFF", "#FFE600"] } };
    const p = plan();
    p.scenes[2]!.captionParams = { "dynamicStyle.captionFillColor": "#00FF00" };
    const events = eventsOf(buildOverlayDocuments(p, cycling, {}).captions!.ass);
    expect(events[0]).toContain("{\\1c&HFFFFFF&}");
    expect(events[1]).toContain("{\\1c&H00E6FF&}");
    expect(events[2]).not.toContain("\\1c"); // the user's colour, through its own style
    const global = eventsOf(buildOverlayDocuments(plan(), cycling, { "dynamicStyle.captionFillColor": "#00FF00" }).captions!.ass);
    expect(global.every((event) => !event.includes("\\1c"))).toBe(true);
  });

  it("(6) checks the fonts every caption style really uses", () => {
    const p = plan({ "dynamicStyle.captionFontFamily": "M PLUS Rounded 1c" });
    p.scenes[0]!.captionParams = { "dynamicStyle.captionFontId": "noto-sans-jp" };
    expect(captionFontsForPlan(p, recipe).sort()).toEqual(["M PLUS Rounded 1c", "Noto Sans CJK JP"]);
    expect(captionFontsForPlan(plan(), recipe)).toEqual(["Noto Sans CJK JP"]);
  });

  it("(20) invalid per-scene values are ignored, never break the render", () => {
    const p = plan();
    p.scenes[0]!.captionParams = { "dynamicStyle.captionFontSizePx": "huge", "dynamicStyle.captionMaxLines": "5" };
    const ass = buildOverlayDocuments(p, recipe, {}).captions!.ass;
    expect(stylesOf(ass)).toHaveLength(1);
  });
});
