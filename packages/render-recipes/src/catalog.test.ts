import { describe, expect, it } from "vitest";
import { CATEGORY_SAMPLES, PREVIEW_PRESETS, PREVIEW_PRESET_IDS, presetLoopMs, RECIPE_CATALOG, recipeCatalogEntry, RELEASED_RECIPES, TEMPLATE_CATEGORIES } from "./index.js";

describe("template library catalog (V04-01)", () => {
  it("describes every released recipe exactly once, and nothing that is not released", () => {
    const released = RELEASED_RECIPES.map((recipe) => recipe.id).sort();
    expect(RECIPE_CATALOG.map((entry) => entry.recipeId).sort()).toEqual(released);
    for (const recipe of RELEASED_RECIPES) expect(recipeCatalogEntry(recipe.id)?.recipeId).toBe(recipe.id);
    expect(recipeCatalogEntry("nope")).toBeNull();
  });

  it("has at least two templates in each of the four groups, with the owner's grouping", () => {
    for (const category of TEMPLATE_CATEGORIES) expect(RECIPE_CATALOG.filter((entry) => entry.category === category).length, category).toBeGreaterThanOrEqual(2);
    const byCategory = (category: string) => RECIPE_CATALOG.filter((entry) => entry.category === category).map((entry) => entry.recipeId);
    expect(byCategory("news")).toEqual(["news-recap-white-top-caption-jp", "news-recap-broadcast-telop-jp"]);
    expect(byCategory("faceless")).toContain("news-recap-photo-video-mix-jp");
  });

  it("presets are pacing only (no effect fields) and loop in 5..8 s", () => {
    for (const id of PREVIEW_PRESET_IDS) {
      const preset = PREVIEW_PRESETS[id];
      expect(Object.keys(preset).sort()).toEqual(["id", "sceneMs", "scenes"]);
      expect(presetLoopMs(preset), id).toBeGreaterThanOrEqual(5000);
      expect(presetLoopMs(preset), id).toBeLessThanOrEqual(8000);
      expect(preset.scenes.length).toBeGreaterThanOrEqual(2);
    }
    for (const entry of RECIPE_CATALOG) expect(PREVIEW_PRESET_IDS).toContain(entry.previewPreset);
  });

  it("has neutral Japanese sample content for every group", () => {
    for (const category of TEMPLATE_CATEGORIES) {
      expect(CATEGORY_SAMPLES[category].headline.length).toBeGreaterThan(0);
      expect(CATEGORY_SAMPLES[category].captions.length).toBeGreaterThanOrEqual(2);
    }
  });
});
