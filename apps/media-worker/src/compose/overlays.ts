import {
  buildCaptionAss,
  captionAssStyle,
  captionDefaultsFromRecipeCaptions,
  captionStyleFromOptionValues,
  legacyCaptionFontFamily,
  resolveCaptionTextStyle,
  type CaptionCueInput,
  type CaptionCueStyle,
  type CaptionStyleOptions,
  type CaptionTextStyle,
} from "@lyonix/domain";
import type { ComposePlan } from "@lyonix/media-jobs";
import { resolveRecipeParams, type RenderRecipe } from "@lyonix/render-recipes";
import { FPS } from "./filtergraph.js";

/**
 * VE2E-105: ASS documents for the burned-in text of a render (voice-timed captions + recipe text layers), produced with the same
 * `buildCaptionAss` the Studio player uses so line breaks match the preview. Pure.
 *
 * VE2E-93: the caption style is resolved with the shared `@lyonix/domain/caption-style` rules - recipe default <- whole-video style
 * (`plan.params`) <- scene override (`scene.captionParams`); a scene with its own style gets its own ASS style.
 */

const frameMs = (frame: number): number => (frame * 1000) / FPS;

export type OverlayDocuments = {
  captions: { ass: string; warnings: string[]; cueCount: number } | null;
  layers: Array<{ layerId: string; ass: string; text: string }>;
  /** Effective slot values after defaults. */
  params: Record<string, string>;
  warnings: string[];
};

export type CaptionCueStyling = {
  /** Style of a scene that has its own caption style (undefined = the document style). */
  sceneStyle?: (sceneId: string) => CaptionCueStyle | undefined;
  /** VE2E-93 (D3): false for a scene whose fill colour the user set - it then wins over the recipe's colour cycle. */
  cycleColour?: (sceneId: string) => boolean;
};

export function captionCuesFromComposePlan(plan: ComposePlan, colorCycle?: readonly string[], styling: CaptionCueStyling = {}): CaptionCueInput[] {
  const cues: CaptionCueInput[] = [];
  for (const [sceneIndex, scene] of plan.scenes.entries()) {
    const cycled = colorCycle && colorCycle.length > 0 && (styling.cycleColour?.(scene.sceneId) ?? true);
    const color = cycled ? colorCycle[sceneIndex % colorCycle.length] : undefined;
    const style = styling.sceneStyle?.(scene.sceneId);
    const sceneStartMs = frameMs(scene.startFrame);
    const sceneEndMs = frameMs(scene.startFrame + scene.durationFrames);
    if (scene.captionCues.length > 0) {
      for (const cue of scene.captionCues) {
        cues.push({
          text: cue.text,
          startMs: sceneStartMs + cue.startMs,
          endMs: Math.min(sceneStartMs + cue.endMs, sceneEndMs),
          ...(color ? { color } : {}),
          ...(cue.charTimings ? { charTimings: cue.charTimings.map((t) => ({ startMs: sceneStartMs + t.startMs, endMs: sceneStartMs + t.endMs })) } : {}),
          ...(style ? { style } : {}),
        });
      }
    } else if (scene.text.trim()) {
      cues.push({ text: scene.text, startMs: sceneStartMs, endMs: sceneEndMs, ...(color ? { color } : {}), ...(style ? { style } : {}) });
    }
  }
  return cues;
}

/** VE2E-93: effective caption style of the whole video and of every scene that has its own override. */
export function captionStylesForPlan(plan: ComposePlan, recipe: RenderRecipe, rawParams: Record<string, string>): { global: CaptionTextStyle; scenes: Map<string, CaptionTextStyle> } {
  const parsed = captionStyleFromOptionValues(rawParams);
  const base = {
    engine: "lyonix" as const,
    defaults: captionDefaultsFromRecipeCaptions(recipe.captions),
    global: parsed.patch,
    legacyFontFamily: legacyCaptionFontFamily("lyonix", parsed.legacyFontFamily),
  };
  const scenes = new Map<string, CaptionTextStyle>();
  for (const scene of plan.scenes) {
    const patch = scene.captionParams ? captionStyleFromOptionValues(scene.captionParams).patch : {};
    if (Object.keys(patch).length > 0) scenes.set(scene.sceneId, resolveCaptionTextStyle({ ...base, scene: patch }));
  }
  return { global: resolveCaptionTextStyle(base), scenes };
}

/** Caption font families a render really uses (whole video + per-scene styles) - the media-worker checks they are installed. */
export function captionFontsForPlan(plan: ComposePlan, recipe: RenderRecipe): string[] {
  const styles = captionStylesForPlan(plan, recipe, plan.params);
  return [...new Set([styles.global.font.family, ...[...styles.scenes.values()].map((style) => style.font.family)])];
}

export function buildOverlayDocuments(plan: ComposePlan, recipe: RenderRecipe, rawParams: Record<string, string>): OverlayDocuments {
  const params = resolveRecipeParams(recipe, rawParams);
  const warnings: string[] = [];
  const canvas = { width: 1080, height: 1920 };

  let captions: OverlayDocuments["captions"] = null;
  if (recipe.captions.enabled) {
    const styles = captionStylesForPlan(plan, recipe, rawParams);
    const style: CaptionStyleOptions = { canvas, fps: FPS, ...captionAssStyle(styles.global) };
    const effective = (sceneId: string) => styles.scenes.get(sceneId) ?? styles.global;
    const cues = captionCuesFromComposePlan(plan, recipe.captions.colorCycle, {
      sceneStyle: (sceneId) => {
        const sceneStyle = styles.scenes.get(sceneId);
        return sceneStyle ? captionAssStyle(sceneStyle) : undefined;
      },
      cycleColour: (sceneId) => !effective(sceneId).fillColorFromUser,
    });
    if (cues.length > 0) {
      const built = buildCaptionAss(cues, style);
      captions = { ass: built.ass, warnings: built.warnings, cueCount: built.cues.length };
      warnings.push(...built.warnings);
    }
  }

  const layers: OverlayDocuments["layers"] = [];
  const totalMs = frameMs(plan.totalFrames);
  for (const layer of recipe.layers) {
    if (layer.type !== "text") continue;
    const text = (params[layer.slot] ?? "").trim();
    if (!text) continue;
    const built = buildCaptionAss([{ text, startMs: 0, endMs: totalMs }], {
      canvas,
      fps: FPS,
      fontName: layer.fontFamily,
      fontSizePx: layer.fontSizePx,
      minFontSizePx: layer.minFontSizePx,
      maxLines: layer.maxLines,
      bold: layer.bold,
      textColor: layer.color,
      highlightColor: layer.color,
      outlineColor: layer.outlineColor,
      outlinePx: layer.outlinePx,
      highlight: "none",
      placement: { x: layer.x + layer.w / 2, y: layer.y + layer.h / 2, widthPx: layer.w },
    });
    layers.push({ layerId: layer.id, ass: built.ass, text });
    warnings.push(...built.warnings);
  }
  return { captions, layers, params, warnings };
}
