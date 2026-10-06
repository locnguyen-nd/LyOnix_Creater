import { describe, expect, it } from "vitest";
import { CATEGORY_SAMPLES, PREVIEW_PRESETS, RELEASED_RECIPES, recipeCatalogEntry, type RenderRecipe } from "@lyonix/render-recipes";
import { buildSimulationPlan, MAX_SCENE_ZOOM, posterTimeMs, sceneScale, simulationFrame } from "./template-simulation";

const planOf = (recipe: RenderRecipe) => {
  const entry = recipeCatalogEntry(recipe.id)!;
  return buildSimulationPlan(recipe, PREVIEW_PRESETS[entry.previewPreset], CATEGORY_SAMPLES[entry.category]);
};
const byId = (id: string) => RELEASED_RECIPES.find((recipe) => recipe.id === id)!;

describe("template motion simulation (V04-01)", () => {
  it("every released recipe loops in 5..8 s over 2-3 sample scenes, with a still poster inside the first scene", () => {
    for (const recipe of RELEASED_RECIPES) {
      const plan = planOf(recipe);
      expect(plan.loopMs, recipe.id).toBeGreaterThanOrEqual(5000);
      expect(plan.loopMs, recipe.id).toBeLessThanOrEqual(8000);
      expect(plan.scenes.length).toBeGreaterThanOrEqual(2);
      expect(posterTimeMs(plan)).toBeLessThan(plan.sceneMs);
      expect(simulationFrame(recipe, plan, posterTimeMs(plan)).transition).toBeNull();
    }
  });

  it("uses the recipe's own transition, capped at half a scene like the engine, and loops back with a cut", () => {
    for (const recipe of RELEASED_RECIPES) {
      const plan = planOf(recipe);
      const scene = plan.scenes[1]!;
      expect(scene.transitionInMs).toBe(Math.min(recipe.transition.durationMs, Math.floor(plan.sceneMs / 2)));
      const mid = simulationFrame(recipe, plan, scene.startMs + scene.transitionInMs / 2);
      expect(mid.transition, recipe.id).toEqual({ kind: recipe.transition.kind, progress: 0.5 });
      expect(mid.layers.map((layer) => layer.scene.index)).toEqual([0, 1]);
      // after the transition: one picture; at the loop start: the first scene again, no transition
      expect(simulationFrame(recipe, plan, scene.startMs + scene.transitionInMs + 1).layers).toHaveLength(1);
      const wrapped = simulationFrame(recipe, plan, plan.loopMs + 10);
      expect(wrapped.sceneIndex).toBe(0);
      expect(wrapped.transition).toBeNull();
    }
    const none = { ...RELEASED_RECIPES[0]!, transition: { kind: "none" as const, durationMs: 400 } };
    const plan = planOf(none);
    expect(simulationFrame(none, plan, plan.sceneMs + 10).transition).toBeNull();
  });

  it("zooms like the engine's motionFor: photo vs clip config, flipped on odd photo scenes when alternate, capped at +0.2, none = still", () => {
    const telop = byId("news-recap-broadcast-telop-jp"); // photos zoom_in 0.06 alternate, clips none
    const scene = (index: number, kind: "image" | "video") => ({ index, kind, visibleFrom: 0, visibleTo: 1000 });
    expect(sceneScale(telop, scene(0, "image"), 0)).toBeCloseTo(1);
    expect(sceneScale(telop, scene(0, "image"), 1000)).toBeCloseTo(1.06);
    expect(sceneScale(telop, scene(1, "image"), 0)).toBeCloseTo(1.06); // odd scene: zooms out
    expect(sceneScale(telop, scene(1, "image"), 1000)).toBeCloseTo(1);
    expect(sceneScale(telop, scene(0, "video"), 500)).toBe(1);
    const player = byId("sports-recap-player-focus-jp"); // photos always in (no alternate), clips zoom in 0.05
    expect(sceneScale(player, scene(1, "image"), 1000)).toBeCloseTo(1.12);
    expect(sceneScale(player, scene(1, "video"), 1000)).toBeCloseTo(1.05);
    const strong = { ...telop, background: { ...telop.background, image: { motion: "zoom_in" as const, intensity: 0.5, alternate: false } } };
    expect(sceneScale(strong, scene(0, "image"), 1000)).toBeCloseTo(1 + MAX_SCENE_ZOOM);
  });

  it("captions: at most 2 lines, the spoken part grows with word highlight, the per-scene colour comes from colorCycle", () => {
    for (const recipe of RELEASED_RECIPES) {
      const plan = planOf(recipe);
      for (let t = 0; t < plan.loopMs; t += 250) {
        const frame = simulationFrame(recipe, plan, t);
        expect(frame.caption, `${recipe.id}@${t}`).not.toBeNull();
        expect(frame.caption!.lines.length).toBeLessThanOrEqual(2);
      }
    }
    const telop = byId("news-recap-broadcast-telop-jp");
    const plan = planOf(telop);
    const early = simulationFrame(telop, plan, 100).caption!;
    const late = simulationFrame(telop, plan, plan.sceneMs - 50).caption!;
    expect(early.spokenChars).not.toBeNull();
    expect(late.spokenChars!).toBeGreaterThan(early.spokenChars!);
    expect(late.highlightColor).toBe(telop.captions.highlightColor);

    const alert = byId("breaking-news-red-alert-jp"); // colorCycle white / yellow, highlight none
    const alertPlan = planOf(alert);
    expect(simulationFrame(alert, alertPlan, 100).caption).toMatchObject({ color: "#FFFFFF", spokenChars: null });
    expect(simulationFrame(alert, alertPlan, alertPlan.sceneMs + 400).caption).toMatchObject({ color: "#FFD400", spokenChars: null });
  });

  it("each scene shows its own sample sentence of the template's group", () => {
    const plan = planOf(byId("sports-highlight-score-headline-jp"));
    const text = (index: number) => plan.scenes[index]!.captionPages.flatMap((page) => page.lines).join("");
    expect(text(0)).toBe(CATEGORY_SAMPLES.sports.captions[0]);
    expect(text(1)).toBe(CATEGORY_SAMPLES.sports.captions[1]);
  });
});
