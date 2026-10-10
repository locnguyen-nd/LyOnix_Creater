import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CATEGORY_SAMPLES, PREVIEW_PRESETS, RELEASED_RECIPES, layerMotionAt, layerMotionFor, recipeCatalogEntry, type RenderRecipe } from "@lyonix/render-recipes";
import { RecipePreview } from "../components/RecipePreview";
import { buildSimulationPlan, overlayMotion, posterTimeMs, simulationFrame } from "./template-simulation";

/** VE2E-157: the template preview moves its overlays and captions with the SAME preset the engine burns into the MP4. */

const planOf = (recipe: RenderRecipe) => {
  const entry = recipeCatalogEntry(recipe.id)!;
  return buildSimulationPlan(recipe, PREVIEW_PRESETS[entry.previewPreset], CATEGORY_SAMPLES[entry.category]);
};
const opacities = (html: string) => [...html.matchAll(/data-testid="recipe-preview-layer"[^>]*/g)].map((m) => m[0]);
const layerOpacity = (html: string) => [...html.matchAll(/<g opacity="([\d.]+)"[^>]*data-testid="recipe-preview-layer"/g)].map((m) => Number(m[1]));

describe("preview motion = engine motion", () => {
  it.each(RELEASED_RECIPES.map((recipe) => [recipe.id, recipe] as const))("%s: overlays enter like the render (hidden at 0, settled on the poster) and leave at the end of the loop", (_id, recipe) => {
    const plan = planOf(recipe);
    for (const layer of recipe.layers) {
      const motion = layerMotionFor(layer);
      expect(overlayMotion(layer, simulationFrame(recipe, plan, 0))).toEqual(layerMotionAt(motion, 0, plan.loopMs));
      expect(overlayMotion(layer, simulationFrame(recipe, plan, 0)).opacity).toBe(0);
      expect(overlayMotion(layer, simulationFrame(recipe, plan, posterTimeMs(plan)))).toEqual({ opacity: 1, dy: 0, scale: 1, growScale: 1 });
      expect(overlayMotion(layer, simulationFrame(recipe, plan, plan.loopMs - 1)).opacity).toBeLessThan(0.05);
    }
    const start = renderToStaticMarkup(<RecipePreview recipe={recipe} atMs={0} />);
    const poster = renderToStaticMarkup(<RecipePreview recipe={recipe} />);
    expect(opacities(poster).length).toBeGreaterThan(0);
    expect(layerOpacity(start).every((value) => value === 0)).toBe(true);
    expect(layerOpacity(poster).every((value) => value === 1)).toBe(true);
  });

  it("the headline rises and the badge pops in the SVG exactly as the preset says, half-way through their entrance", () => {
    const recipe = RELEASED_RECIPES.find((entry) => entry.id === "breaking-news-urgent-headline-jp")!;
    const html = renderToStaticMarkup(<RecipePreview recipe={recipe} atMs={250 + 225} />);
    const headline = /<g opacity="([\d.]+)" transform="translate\(0 ([\d.]+)\)"[^>]*data-layer="headline-text"/.exec(html);
    expect(headline && [Number(headline[1]), Number(headline[2])]).toEqual([0.5, 14]);
    expect(html).toContain('<g opacity="1.000" data-testid="recipe-preview-layer" data-layer="badge-box"'); // settled by then: no transform left
    const early = renderToStaticMarkup(<RecipePreview recipe={recipe} atMs={150 + 140} />);
    const popping = /translate\(230 265\) scale\(([\d.]+)\)[^"]*"[^>]*data-layer="badge-box"/.exec(early);
    expect(popping && Number(popping[1])).toBeCloseTo(0.9, 3);
  });

  it("each caption phrase fades + pops in as it starts (same 90 ms / 92 % as the render)", () => {
    const recipe = RELEASED_RECIPES.find((entry) => entry.id === "news-recap-broadcast-telop-jp")!;
    const plan = planOf(recipe);
    const scene = plan.scenes[1]!;
    const page = scene.captionPages[0]!;
    expect(simulationFrame(recipe, plan, scene.startMs + page.startMs).caption!.entrance).toEqual({ opacity: 0, scale: 0.92 });
    expect(simulationFrame(recipe, plan, scene.startMs + page.startMs + 400).caption!.entrance).toEqual({ opacity: 1, scale: 1 });
    expect(renderToStaticMarkup(<RecipePreview recipe={recipe} atMs={scene.startMs + page.startMs + 45} />)).toMatch(/<g opacity="0.500" transform="[^"]*scale\(0.9[0-9]+\)[^"]*" data-testid="recipe-preview-caption-block"/);
  });
});
