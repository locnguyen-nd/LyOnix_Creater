import { describe, expect, it } from "vitest";
import { LAYER_EXIT_FADE_MS, RELEASED_RECIPES, layerMotionFor, type RenderRecipe } from "@lyonix/render-recipes";
import { buildVideoGraph } from "./filtergraph.js";
import { boxColor, boxLayerAss, buildOverlayDocuments } from "./overlays.js";
import { evaluateSignal, parseBlackdetect } from "./qc-signal.js";
import { makePlan, type FixtureFiles } from "./test-fixtures.js";

/** VE2E-157 (`compose.v2`): what the engine burns into the MP4 for the overlays of every released recipe. Pure - no FFmpeg here. */

const files: FixtureFiles = { image: "projects/p/still.jpg", landscape: "projects/p/landscape.mp4", portraitShort: "projects/p/portrait-short.mp4", voices: ["projects/p/v0.mp3", "projects/p/v1.mp3", "projects/p/v2.mp3"], music: "projects/p/music.wav" };
const SLOTS = { headline: "佐々木朗希、復帰登板で好投", badge: "速報" };
const dialogue = (ass: string) => ass.split("\n").find((line) => line.startsWith("Dialogue:"))!;

describe("animated overlays of every released recipe", () => {
  it.each(RELEASED_RECIPES.map((recipe) => [`${recipe.id}@${recipe.version}`, recipe] as const))("%s: one animated document per visible layer, in the recipe's order", (_name, recipe: RenderRecipe) => {
    const plan = makePlan(files, { texts: ["一つ目の文です", "二つ目の文です", "三つ目の文です"] });
    const docs = buildOverlayDocuments(plan, recipe, SLOTS);
    const visible = recipe.layers.filter((layer) => !layer.visibleIfSlot || (SLOTS as Record<string, string>)[layer.visibleIfSlot]);
    expect(docs.layers.map((layer) => layer.layerId)).toEqual(visible.map((layer) => layer.id));
    const totalMs = (plan.totalFrames * 1000) / 60;
    for (const doc of docs.layers) {
      const line = dialogue(doc.ass);
      expect(line, doc.layerId).toMatch(new RegExp(`\\\\fad\\(\\d+,${LAYER_EXIT_FADE_MS}\\)`)); // every layer leaves with the same exit
      if (doc.kind === "box") expect(line, doc.layerId).toMatch(/\\p1\}m 0 0 l \d+ 0 \d+ \d+ 0 \d+\{\\p0\}/); // an ASS drawing, not a static drawbox
      if (doc.motion.role === "headline") expect(line, doc.layerId).toContain("\\move(");
      if (doc.motion.role === "badge") expect(line, doc.layerId).toContain("\\fscx80\\fscy80\\t(0,280,\\fscx100\\fscy100)");
      if (doc.motion.role === "panel") expect(line, doc.layerId).toMatch(/\\an7\\pos\(\d+,\d+\).*\\fscx0\\t\(0,350,\\fscx100\)/);
      if (doc.motion.grow === "y") expect(line, doc.layerId).toMatch(/\\an8.*\\fscy0\\t\(0,450,\\fscy100\)/);
      expect(doc.motion, doc.layerId).toEqual(layerMotionFor(recipe.layers.find((layer) => layer.id === doc.layerId)!));
    }
    expect(totalMs).toBeGreaterThan(1000);
    // every caption phrase pops in with its voice
    if (docs.captions) for (const line of docs.captions.ass.split("\n").filter((l) => l.startsWith("Dialogue:"))) expect(line).toContain("{\\fad(90,0)\\fscx92\\fscy92\\t(0,150,\\fscx100\\fscy100)}");
  });

  it("box documents keep the recipe's geometry, colour (literal or slot) and opacity", () => {
    const recipe = RELEASED_RECIPES.find((entry) => entry.id === "news-recap-broadcast-telop-jp")!;
    const band = recipe.layers.find((layer) => layer.id === "telop-band")!;
    if (band.type !== "box") throw new Error("band");
    expect(boxColor(band, recipe, {})).toBe("#C8102E"); // slot:accent default
    expect(boxColor(band, recipe, { accent: "#123456" })).toBe("#123456");
    const ass = boxLayerAss(band, "#C8102E", layerMotionFor(band), 8000);
    const line = dialogue(ass);
    expect(line).toContain("\\an7\\pos(0,200)");
    expect(line).toContain("\\1c&H2E10C8&"); // BGR
    expect(line).toContain("\\1a&H0F&"); // opacity 0.94
    expect(line).toContain("m 0 0 l 1080 0 1080 210 0 210");
    expect(line.startsWith("Dialogue: 0,0:00:00.00,0:00:08.00,Box")).toBe(true);
  });

  it("the filtergraph draws boxes from their animated documents (drawbox only for a caller without one)", () => {
    const recipe = RELEASED_RECIPES.find((entry) => entry.id === "breaking-news-red-alert-jp")!;
    const plan = makePlan(files, { texts: ["一", "二", "三"] });
    const layerAss = Object.fromEntries(recipe.layers.map((layer) => [layer.id, `${layer.id}.ass`]));
    const graph = buildVideoGraph({ plan, recipe, params: SLOTS, mediaPaths: ["/m/a.jpg", "/m/b.mp4", "/m/c.mp4"], overlays: { layerAss, captionsAss: null }, fontsDir: null });
    expect(graph.filterComplex).not.toMatch(/drawbox=x=\d+:y=\d+:w=\d+/); // (the full-frame tint stays a drawbox)
    expect(recipe.layers.map((layer) => graph.filterComplex.indexOf(`ass=filename=${layer.id}.ass`))).toEqual([...recipe.layers.map((layer) => graph.filterComplex.indexOf(`ass=filename=${layer.id}.ass`))].sort((a, b) => a - b));
    const legacy = buildVideoGraph({ plan, recipe, params: SLOTS, mediaPaths: ["/m/a.jpg", "/m/b.mp4", "/m/c.mp4"], overlays: { layerAss: {}, captionsAss: null }, fontsDir: null });
    expect(legacy.filterComplex).toContain("drawbox=x=0:y=200:w=1080:h=96");
  });
});

describe("QC_WHITE_FRAMES", () => {
  it("reads the black and the white detector of the same pass apart", () => {
    const stderr = "[blackdetect@dark @ 0x1] black_start:0 black_end:0.5 black_duration:0.5\n[blackdetect@bright @ 0x2] black_start:3 black_end:4.2 black_duration:1.2";
    expect(parseBlackdetect(stderr, "dark")).toEqual([0.5]);
    expect(parseBlackdetect(stderr, "bright")).toEqual([1.2]);
  });

  it("a blank white stretch fails with its own code; none passes", () => {
    const good = { integratedLufs: -14.2, truePeakDbtp: -1.5, blackSegmentsSec: [], freezeSegmentsSec: [] };
    const failing = (white: number[]) => evaluateSignal({ ...good, whiteSegmentsSec: white }, -14, true).filter((check) => !check.ok).map((check) => check.code);
    expect(failing([])).toEqual([]);
    expect(failing([0.8])).toEqual(["QC_WHITE_FRAMES"]);
  });
});
