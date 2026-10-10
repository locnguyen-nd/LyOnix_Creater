import { describe, expect, it } from "vitest";
import { CAPTION_MOTION, LAYER_EXIT_FADE_MS, LAYER_MOTION, captionMotionAt, layerMotionAt, layerMotionFor, RELEASED_RECIPES, type RecipeLayer } from "./index.js";

const layer = (recipeId: string, layerId: string): RecipeLayer => RELEASED_RECIPES.find((recipe) => recipe.id === recipeId)!.layers.find((entry) => entry.id === layerId)!;

describe("VE2E-157 shared motion preset", () => {
  it("roles come from geometry + slot: bands / plates are panels, thin lines rules, the badge pops, the headline rises", () => {
    expect(layerMotionFor(layer("news-recap-broadcast-telop-jp", "telop-band")).role).toBe("panel");
    expect(layerMotionFor(layer("news-recap-photo-video-mix-jp", "lower-plate")).role).toBe("panel");
    expect(layerMotionFor(layer("breaking-news-red-alert-jp", "headline-box")).role).toBe("panel");
    expect(layerMotionFor(layer("news-recap-white-top-caption-jp", "badge-box")).role).toBe("badge");
    expect(layerMotionFor(layer("news-recap-white-top-caption-jp", "badge-text")).role).toBe("badge");
    expect(layerMotionFor(layer("breaking-news-red-alert-jp", "alert-text")).role).toBe("badge");
    expect(layerMotionFor(layer("breaking-news-urgent-headline-jp", "headline-text")).role).toBe("headline");
    expect(layerMotionFor(layer("breaking-news-urgent-headline-jp", "headline-rule"))).toMatchObject({ role: "rule", grow: "x" });
    expect(layerMotionFor(layer("sports-recap-player-focus-jp", "lower-third-accent"))).toMatchObject({ role: "rule", grow: "y" });
  });

  it("every layer of every released recipe moves (no static overlay), with one timing for the whole library: settled within 0.85 s", () => {
    for (const recipe of RELEASED_RECIPES) {
      for (const entry of recipe.layers) {
        const motion = layerMotionFor(entry);
        expect(motion.fadeInMs, `${recipe.id}/${entry.id}`).toBeGreaterThan(0);
        expect(motion.delayMs + Math.max(motion.fadeInMs, motion.scaleMs), `${recipe.id}/${entry.id}`).toBeLessThanOrEqual(850);
        expect(motion).toMatchObject({ delayMs: LAYER_MOTION[motion.role].delayMs, fadeInMs: LAYER_MOTION[motion.role].fadeInMs });
      }
    }
    // staggered entrance: the frame first, then the badge, the headline, the rule
    expect([LAYER_MOTION.panel, LAYER_MOTION.badge, LAYER_MOTION.headline, LAYER_MOTION.rule].map((m) => m.delayMs)).toEqual([0, 150, 250, 400]);
  });

  it("layerMotionAt: hidden before the delay, linear entrance, steady, then the exit fade over the last 0.3 s", () => {
    const headline = layerMotionFor(layer("breaking-news-urgent-headline-jp", "headline-text"));
    const total = 10_000;
    expect(layerMotionAt(headline, 100, total)).toEqual({ opacity: 0, dy: 28, scale: 1, growScale: 1 });
    const half = layerMotionAt(headline, 250 + 225, total);
    expect(half.opacity).toBeCloseTo(0.5, 5);
    expect(half.dy).toBeCloseTo(14, 5);
    expect(layerMotionAt(headline, 2000, total)).toEqual({ opacity: 1, dy: 0, scale: 1, growScale: 1 });
    expect(layerMotionAt(headline, total - LAYER_EXIT_FADE_MS / 2, total).opacity).toBeCloseTo(0.5, 5);
    expect(layerMotionAt(headline, total, total).opacity).toBe(0);

    const badge = layerMotionFor(layer("breaking-news-urgent-headline-jp", "badge-box"));
    expect(layerMotionAt(badge, 150, total).scale).toBeCloseTo(0.8, 5);
    expect(layerMotionAt(badge, 150 + 140, total).scale).toBeCloseTo(0.9, 5);
    expect(layerMotionAt(badge, 1000, total).scale).toBe(1);

    const rule = layerMotionFor(layer("breaking-news-urgent-headline-jp", "headline-rule"));
    expect(layerMotionAt(rule, 400 + 225, total).growScale).toBeCloseTo(0.5, 5);
  });

  it("captionMotionAt: each phrase fades in over 90 ms and pops from 92 % to 100 % over 150 ms, then stays", () => {
    expect(captionMotionAt(-1)).toEqual({ opacity: 0, scale: 0.92 });
    expect(captionMotionAt(45).opacity).toBeCloseTo(0.5, 5);
    expect(captionMotionAt(75).scale).toBeCloseTo(0.96, 5);
    expect(captionMotionAt(CAPTION_MOTION.popMs)).toEqual({ opacity: 1, scale: 1 });
  });
});
