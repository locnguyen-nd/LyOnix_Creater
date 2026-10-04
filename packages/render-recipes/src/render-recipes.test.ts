import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1, RecipeRegistry, RELEASED_RECIPES, recipeRegistry, recipeToModificationSlots, resolveRecipeParams, validateRecipe, type RenderRecipe } from "./index.js";

const clone = (): RenderRecipe => structuredClone(NEWS_RECAP_BROADCAST_TELOP_JP_V1);
const errorsOf = (recipe: unknown): string[] => {
  const result = validateRecipe(recipe);
  return result.ok ? [] : result.errors;
};

describe("released recipes", () => {
  it("every released recipe is valid and unique by id@version, and the registry resolves them", () => {
    expect(RELEASED_RECIPES.length).toBeGreaterThan(0);
    for (const recipe of RELEASED_RECIPES) expect(errorsOf(recipe)).toEqual([]);
    expect(recipeRegistry.get("news-recap-broadcast-telop-jp", 1)).toBe(NEWS_RECAP_BROADCAST_TELOP_JP_V1);
    expect(recipeRegistry.get("news-recap-broadcast-telop-jp", 2)).toBeNull();
    expect(recipeRegistry.latest("news-recap-broadcast-telop-jp")?.version).toBe(1);
    expect(recipeRegistry.latest("nope")).toBeNull();
    expect(() => new RecipeRegistry([NEWS_RECAP_BROADCAST_TELOP_JP_V1, NEWS_RECAP_BROADCAST_TELOP_JP_V1])).toThrow(/twice/);
    expect(() => new RecipeRegistry([{ ...clone(), fps: 30 } as unknown as RenderRecipe])).toThrow(/invalid/);
  });

  it("news-recap-broadcast-telop-jp@1 is immutable: its digest is pinned (a change must ship as a new version)", () => {
    const digest = createHash("sha256").update(JSON.stringify(NEWS_RECAP_BROADCAST_TELOP_JP_V1)).digest("hex");
    expect(digest).toBe(PINNED_DIGEST_V1);
  });

  it("keeps the headline band below the TikTok top safe zone and text inside the side safe zones", () => {
    for (const layer of NEWS_RECAP_BROADCAST_TELOP_JP_V1.layers) {
      expect(layer.y, layer.id).toBeGreaterThanOrEqual(1920 * 0.1);
      if (layer.type === "text") {
        expect(layer.x, layer.id).toBeGreaterThanOrEqual(1080 * 0.12);
        expect(layer.x + layer.w, layer.id).toBeLessThanOrEqual(1080 * (1 - 0.12));
      }
    }
  });

  it("lists its option slots in the template-modification shape and resolves defaults", () => {
    expect(recipeToModificationSlots(NEWS_RECAP_BROADCAST_TELOP_JP_V1).map((s) => [s.key, s.kind])).toEqual([["headline", "text"], ["badge", "text"], ["accent", "color"]]);
    expect(resolveRecipeParams(NEWS_RECAP_BROADCAST_TELOP_JP_V1, {})).toEqual({ headline: "", badge: "速報", accent: "#C8102E" });
    expect(resolveRecipeParams(NEWS_RECAP_BROADCAST_TELOP_JP_V1, { headline: "  見出し ", badge: "  " })).toMatchObject({ headline: "見出し", badge: "速報" });
  });
});

describe("validateRecipe", () => {
  it("rejects the things that would break a render", () => {
    expect(errorsOf(null)).toEqual(["recipe must be an object"]);
    expect(errorsOf({ ...clone(), fps: 30 }).join()).toMatch(/fps/);
    expect(errorsOf({ ...clone(), canvas: { width: 720, height: 1280 } }).join()).toMatch(/canvas/);
    expect(errorsOf({ ...clone(), id: "Bad Id" }).join()).toMatch(/id/);
    expect(errorsOf({ ...clone(), version: 0 }).join()).toMatch(/version/);
    expect(errorsOf({ ...clone(), transition: { kind: "spin", durationMs: 400 } }).join()).toMatch(/transition/);
    expect(errorsOf({ ...clone(), audio: { ...clone().audio, musicDuckDb: -5, musicBaseDb: -14 } }).join()).toMatch(/musicDuckDb/);

    const layerOutside = clone();
    layerOutside.layers[0] = { ...(layerOutside.layers[0] as RenderRecipe["layers"][number]), x: 100, w: 1080 };
    expect(errorsOf(layerOutside).join()).toMatch(/past the canvas width/);

    const unknownSlot = clone();
    (unknownSlot.layers[2] as { slot: string }).slot = "nope";
    expect(errorsOf(unknownSlot).join()).toMatch(/slot must name a text slot/);

    const dup = clone();
    dup.layers[1] = { ...(dup.layers[1] as RenderRecipe["layers"][number]), id: "telop-band" };
    expect(errorsOf(dup).join()).toMatch(/duplicated/);

    const badColor = clone();
    (badColor.layers[0] as { color: string }).color = "red";
    expect(errorsOf(badColor).join()).toMatch(/color/);

    const badCaption = clone();
    badCaption.captions.minFontSizePx = 100;
    expect(errorsOf(badCaption).join()).toMatch(/font sizes/);

    const badVisible = clone();
    (badVisible.layers[0] as { visibleIfSlot: string }).visibleIfSlot = "ghost";
    expect(errorsOf(badVisible).join()).toMatch(/visibleIfSlot/);
  });
});

const PINNED_DIGEST_V1 = "21ac8a7862fc29d1717007129d7f5bccfd27a99dcf34265e2655cb3b5afd34b8";
