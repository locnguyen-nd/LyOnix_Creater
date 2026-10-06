/**
 * V04-01: motion preview of an internal (LyOnix) template - pure, no DOM, no network, no cost. A loop of 2-3 sample scenes (pacing from
 * the catalog preset) that uses ONLY what the engine renders, computed the way apps/media-worker/src/compose/filtergraph.ts does it:
 *  - timeline: the transition INTO scene i starts at scene i's start while the previous scene stays visible under it; its length is
 *    `recipe.transition.durationMs` capped at half a scene (`planSceneTimeline`); the loop restarts with a cut;
 *  - zoom: from the centre, linear over the scene's visible time, photo vs clip config, direction flipped on odd scenes when
 *    `alternate` (photos only), at most +0.2 (`motionFor`);
 *  - captions: the scene's sample sentence laid out by the shared `buildCaptionAss` (same pages, at most 2 lines); with
 *    `highlight: "word"` the spoken part turns `highlightColor`, otherwise the scene's `colorCycle` colour applies.
 * Boxes / text layers are static and the tint covers the whole frame (drawn by RecipePreview). Never part of a job or a render.
 */
import type { CatalogSample, PreviewPreset, RecipeTransitionKind, RenderRecipe } from "@lyonix/render-recipes";
import { layoutSceneCaption, pageAt, type PreviewCaptionPage } from "./full-preview-plan";

export const MAX_SCENE_ZOOM = 0.2;
/** The voice usually ends a little before its scene: the spoken highlight reaches the last word at this share of the page. */
const SPOKEN_SHARE = 0.9;

export type SimulationScene = {
  index: number;
  kind: "image" | "video";
  startMs: number;
  /** Visible range (the first scene starts at 0, a scene followed by a transition stays visible under the next one). */
  visibleFrom: number;
  visibleTo: number;
  transitionInMs: number;
  captionPages: PreviewCaptionPage[];
  /** Caption colour of this scene: `colorCycle[i % n]`, else the recipe's text colour. */
  captionColor: string;
};

export type SimulationPlan = { loopMs: number; sceneMs: number; transitionKind: RecipeTransitionKind; scenes: SimulationScene[] };

export type SimulationCaption = { lines: readonly string[]; fontSizePx: number; color: string; highlightColor: string; spokenChars: number | null };

export type SimulationFrame = {
  sceneIndex: number;
  /** Bottom to top: the outgoing scene (during a transition) then the current one. */
  layers: Array<{ scene: SimulationScene; scale: number }>;
  transition: { kind: Exclude<RecipeTransitionKind, "none">; progress: number } | null;
  caption: SimulationCaption | null;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function buildSimulationPlan(recipe: RenderRecipe, preset: PreviewPreset, sample: CatalogSample): SimulationPlan {
  const count = preset.scenes.length;
  const sceneMs = preset.sceneMs;
  const loopMs = count * sceneMs;
  const transitionKind = recipe.transition.kind;
  const transitionMs = transitionKind === "none" ? 0 : Math.max(0, Math.min(recipe.transition.durationMs, Math.floor(sceneMs / 2)));
  const cycle = recipe.captions.colorCycle;
  const scenes = preset.scenes.map((kind, index): SimulationScene => {
    const startMs = index * sceneMs;
    const isLast = index === count - 1;
    const text = sample.captions.length > 0 ? sample.captions[index % sample.captions.length]! : "";
    return {
      index,
      kind,
      startMs,
      visibleFrom: startMs,
      visibleTo: isLast ? loopMs : (index + 1) * sceneMs + transitionMs,
      transitionInMs: index === 0 ? 0 : transitionMs,
      captionPages: recipe.captions.enabled ? layoutSceneCaption(text, sceneMs, recipe) : [],
      captionColor: cycle && cycle.length > 0 ? cycle[index % cycle.length]! : recipe.captions.textColor,
    };
  });
  return { loopMs, sceneMs, transitionKind, scenes };
}

/** Zoom factor of a scene at `tMs` (same rule as the engine's `motionFor` + scale expression). */
export function sceneScale(recipe: RenderRecipe, scene: Pick<SimulationScene, "index" | "kind" | "visibleFrom" | "visibleTo">, tMs: number): number {
  const config = scene.kind === "image" ? recipe.background.image : recipe.background.video;
  if (config.motion === "none" || config.intensity <= 0) return 1;
  let inward = config.motion === "zoom_in";
  if (scene.kind === "image" && recipe.background.image.alternate && scene.index % 2 === 1) inward = !inward;
  const intensity = Math.min(config.intensity, MAX_SCENE_ZOOM);
  const progress = clamp01((tMs - scene.visibleFrom) / Math.max(1, scene.visibleTo - scene.visibleFrom));
  return inward ? 1 + intensity * progress : 1 + intensity * (1 - progress);
}

export function simulationFrame(recipe: RenderRecipe, plan: SimulationPlan, tMs: number): SimulationFrame {
  const t = ((tMs % plan.loopMs) + plan.loopMs) % plan.loopMs;
  const current = plan.scenes.findLast((scene) => scene.startMs <= t) ?? plan.scenes[0]!;
  const inTransition = current.transitionInMs > 0 && t < current.startMs + current.transitionInMs && plan.transitionKind !== "none";
  const previous = inTransition ? plan.scenes[current.index - 1] : undefined;
  const layers = [...(previous ? [{ scene: previous, scale: sceneScale(recipe, previous, t) }] : []), { scene: current, scale: sceneScale(recipe, current, t) }];
  const transition = previous && plan.transitionKind !== "none" ? { kind: plan.transitionKind, progress: clamp01((t - current.startMs) / current.transitionInMs) } : null;

  const offset = t - current.startMs;
  const page = pageAt(current.captionPages, offset);
  let caption: SimulationCaption | null = null;
  if (page) {
    const total = page.lines.reduce((sum, line) => sum + [...line].length, 0);
    const share = clamp01((offset - page.startMs) / Math.max(1, (page.endMs - page.startMs) * SPOKEN_SHARE));
    caption = {
      lines: page.lines,
      fontSizePx: page.fontSizePx,
      color: current.captionColor,
      highlightColor: recipe.captions.highlightColor,
      spokenChars: recipe.captions.highlight === "word" ? Math.min(total, Math.floor(total * share)) : null,
    };
  }
  return { sceneIndex: current.index, layers, transition, caption };
}

/** The still frame used as the template's picture: well into the first scene (zoom under way, part of the caption spoken). */
export const posterTimeMs = (plan: SimulationPlan): number => Math.round(plan.sceneMs * 0.6);
