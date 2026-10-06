import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BREAKING_NEWS_RED_ALERT_JP_V1, BREAKING_NEWS_URGENT_HEADLINE_JP_V1, FACELESS_STORY_CAPTION_CENTER_JP_V1, NEWS_RECAP_BROADCAST_TELOP_JP_V1, NEWS_RECAP_PHOTO_VIDEO_MIX_JP_V1, NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1, RecipeRegistry, SPORTS_HIGHLIGHT_SCORE_HEADLINE_JP_V1, SPORTS_RECAP_PLAYER_FOCUS_JP_V1, RELEASED_RECIPES, recipeRegistry, recipeToModificationSlots, resolveRecipeParams, validateRecipe, type RenderRecipe } from "./index.js";

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

  it("V03-03: a caption never shows more than 2 lines - every released recipe uses 1..2 and 3 is rejected", () => {
    for (const recipe of RELEASED_RECIPES) expect(recipe.captions.maxLines, recipe.id).toBeLessThanOrEqual(2);
    const threeLines = clone();
    threeLines.captions.maxLines = 3;
    expect(errorsOf(threeLines)).toContain("captions.maxLines must be 1..2");
  });

  it("news-recap-broadcast-telop-jp@1 is immutable: its digest is pinned (a change must ship as a new version)", () => {
    const digest = createHash("sha256").update(JSON.stringify(NEWS_RECAP_BROADCAST_TELOP_JP_V1)).digest("hex");
    expect(digest).toBe(PINNED_DIGEST_V1);
  });

  it("keeps every text layer below the TikTok top safe zone and inside the side safe zones, in every released recipe", () => {
    for (const recipe of RELEASED_RECIPES) {
      for (const layer of recipe.layers) {
        if (layer.type !== "text") continue;
        expect(layer.y, `${recipe.id}/${layer.id}`).toBeGreaterThanOrEqual(1920 * 0.1);
        expect(layer.y + layer.h, `${recipe.id}/${layer.id}`).toBeLessThanOrEqual(1920 * 0.8);
        expect(layer.x, `${recipe.id}/${layer.id}`).toBeGreaterThanOrEqual(1080 * 0.12);
        expect(layer.x + layer.w, `${recipe.id}/${layer.id}`).toBeLessThanOrEqual(1080 * (1 - 0.12));
      }
      const placement = recipe.captions.placement;
      // captions: bottom edge >= 20 % above the bottom, or top edge >= 10 % below the top
      if (placement?.anchor === "top") expect(placement.marginPct, recipe.id).toBeGreaterThanOrEqual(10);
      else expect(placement?.marginPct ?? 20, recipe.id).toBeGreaterThanOrEqual(20);
    }
  });

  it("ships the three news recaps and the five V04-01 library recipes, each immutable (digest pinned) and with the shared 60 fps / -14 LUFS standard", () => {
    expect(RELEASED_RECIPES.map((r) => r.id)).toEqual([
      "news-recap-broadcast-telop-jp",
      "news-recap-photo-video-mix-jp",
      "news-recap-white-top-caption-jp",
      "sports-highlight-score-headline-jp",
      "sports-recap-player-focus-jp",
      "faceless-story-caption-center-jp",
      "breaking-news-red-alert-jp",
      "breaking-news-urgent-headline-jp",
    ]);
    const digest = (recipe: unknown) => createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
    expect(digest(NEWS_RECAP_PHOTO_VIDEO_MIX_JP_V1)).toBe(PINNED_DIGEST_PHOTO_VIDEO_MIX_V1);
    expect(digest(NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1)).toBe(PINNED_DIGEST_WHITE_TOP_V1);
    expect(digest(SPORTS_HIGHLIGHT_SCORE_HEADLINE_JP_V1)).toBe("21673326e764287a1540aa00a2bda09277598d7f1d40ad91e352b3b25dfc93eb");
    expect(digest(SPORTS_RECAP_PLAYER_FOCUS_JP_V1)).toBe("86f08d1e185615e727f5f217db7c4a25e3226d17bd59a9c8a3cc789bdf0df989");
    expect(digest(FACELESS_STORY_CAPTION_CENTER_JP_V1)).toBe("2acd933b0305f279e6f0fce4cd0473e3d4a3f7549a9c165016cf187cdc7221e1");
    expect(digest(BREAKING_NEWS_RED_ALERT_JP_V1)).toBe("b87fb920216819799cecab3ca3e8c02e7768cf72502e3cc4f975cbac415e7e3d");
    expect(digest(BREAKING_NEWS_URGENT_HEADLINE_JP_V1)).toBe("958fa2dbf817c7e2fb06bb7155781f5628f4b43347732f61226b168c4d160b64");
    for (const recipe of RELEASED_RECIPES) {
      expect(recipe.fps).toBe(60);
      expect(recipe.audio.loudnessLufs).toBe(-14);
      expect(recipe.audio.truePeakDb).toBeLessThanOrEqual(-1);
      expect(recipe.audio.musicBaseDb - recipe.audio.musicDuckDb).toBe(12);
    }
  });

  it("white-top-caption: a 44 % picture band on a dark canvas, captions on top alternating white/yellow", () => {
    const r = NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1;
    expect(r.background.frame).toEqual({ mode: "band", heightPct: 44, centerYPct: 50, canvasColor: "#0B0B0B" });
    expect(r.captions.placement).toEqual({ anchor: "top", marginPct: 12 });
    expect(r.captions.colorCycle).toEqual(["#FFFFFF", "#FFE600"]);
    expect(r.captions.highlight).toBe("none");
    expect(recipeToModificationSlots(r).map((s) => s.key)).toEqual(["badge"]);
  });

  it("lists its option slots in the template-modification shape and resolves defaults", () => {
    expect(recipeToModificationSlots(NEWS_RECAP_BROADCAST_TELOP_JP_V1).map((s) => [s.key, s.kind])).toEqual([["headline", "text"], ["badge", "text"], ["accent", "color"]]);
    expect(resolveRecipeParams(NEWS_RECAP_BROADCAST_TELOP_JP_V1, {})).toEqual({ headline: "", badge: "速報", accent: "#C8102E" });
    expect(resolveRecipeParams(NEWS_RECAP_BROADCAST_TELOP_JP_V1, { headline: "  見出し ", badge: "  " })).toMatchObject({ headline: "見出し", badge: "速報" });
  });
});

describe("validateRecipe - frame, placement and colour cycle", () => {
  const base = () => structuredClone(NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1);
  it("accepts the optional fields and rejects broken ones", () => {
    expect(errorsOf(base())).toEqual([]);
    const badFrame = base();
    badFrame.background.frame = { mode: "band", heightPct: 44, centerYPct: 10, canvasColor: "#0B0B0B" };
    expect(errorsOf(badFrame).join()).toMatch(/band must lie inside the canvas/);
    const badMode = base();
    (badMode.background.frame as { mode: string }).mode = "circle";
    expect(errorsOf(badMode).join()).toMatch(/background.frame/);
    const badColor = base();
    badColor.background.frame!.canvasColor = "dark";
    expect(errorsOf(badColor).join()).toMatch(/background.frame/);
    const badPlacement = base();
    badPlacement.captions.placement = { anchor: "left" as never, marginPct: 12 };
    expect(errorsOf(badPlacement).join()).toMatch(/placement/);
    const hugeMargin = base();
    hugeMargin.captions.placement = { anchor: "top", marginPct: 60 };
    expect(errorsOf(hugeMargin).join()).toMatch(/placement/);
    const badCycle = base();
    badCycle.captions.colorCycle = ["#FFF"];
    expect(errorsOf(badCycle).join()).toMatch(/colorCycle/);
    const cycleWithHighlight = base();
    cycleWithHighlight.captions.highlight = "word";
    expect(errorsOf(cycleWithHighlight).join()).toMatch(/needs highlight: none/);
  });
  it("the original broadcast-telop recipe (no frame/placement/cycle) is untouched by the schema growth", () => {
    expect(NEWS_RECAP_BROADCAST_TELOP_JP_V1.background.frame).toBeUndefined();
    expect(NEWS_RECAP_BROADCAST_TELOP_JP_V1.captions.placement).toBeUndefined();
    expect(errorsOf(NEWS_RECAP_BROADCAST_TELOP_JP_V1)).toEqual([]);
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
const PINNED_DIGEST_PHOTO_VIDEO_MIX_V1 = "b1df264402e2cd8a1681651c77f567ce4c8f2d8a6c82afa23fb535e92438d3e9";
const PINNED_DIGEST_WHITE_TOP_V1 = "734d65bfbdd82cd46f64e960072f28783366638b6d94f04fc64a4b9017f2ecbb";
