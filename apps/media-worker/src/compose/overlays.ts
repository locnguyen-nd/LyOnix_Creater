import { buildCaptionAss, type CaptionCueInput, type CaptionStyleOptions } from "@lyonix/domain";
import type { ComposePlan } from "@lyonix/media-jobs";
import { resolveRecipeParams, type RenderRecipe } from "@lyonix/render-recipes";
import { FPS } from "./filtergraph.js";

/**
 * VE2E-105: ASS documents for the burned-in text of a render (voice-timed captions + recipe text layers), produced with the same
 * `buildCaptionAss` the Studio player uses so line breaks match the preview. Pure.
 */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FONT_RE = /^[\p{L}\p{N} ._-]{1,80}$/u;
const frameMs = (frame: number): number => (frame * 1000) / FPS;

export type OverlayDocuments = {
  captions: { ass: string; warnings: string[]; cueCount: number } | null;
  layers: Array<{ layerId: string; ass: string; text: string }>;
  /** Effective slot values after defaults. */
  params: Record<string, string>;
  warnings: string[];
};

export function captionCuesFromComposePlan(plan: ComposePlan): CaptionCueInput[] {
  const cues: CaptionCueInput[] = [];
  for (const scene of plan.scenes) {
    const sceneStartMs = frameMs(scene.startFrame);
    const sceneEndMs = frameMs(scene.startFrame + scene.durationFrames);
    if (scene.captionCues.length > 0) {
      for (const cue of scene.captionCues) {
        cues.push({
          text: cue.text,
          startMs: sceneStartMs + cue.startMs,
          endMs: Math.min(sceneStartMs + cue.endMs, sceneEndMs),
          ...(cue.charTimings ? { charTimings: cue.charTimings.map((t) => ({ startMs: sceneStartMs + t.startMs, endMs: sceneStartMs + t.endMs })) } : {}),
        });
      }
    } else if (scene.text.trim()) {
      cues.push({ text: scene.text, startMs: sceneStartMs, endMs: sceneEndMs });
    }
  }
  return cues;
}

export function buildOverlayDocuments(plan: ComposePlan, recipe: RenderRecipe, rawParams: Record<string, string>): OverlayDocuments {
  const params = resolveRecipeParams(recipe, rawParams);
  const warnings: string[] = [];
  const canvas = { width: 1080, height: 1920 };

  let captions: OverlayDocuments["captions"] = null;
  if (recipe.captions.enabled) {
    const fontOverride = rawParams["dynamicStyle.captionFontFamily"]?.trim();
    const colorOverride = rawParams["dynamicStyle.captionFillColor"]?.trim();
    const style: CaptionStyleOptions = {
      canvas,
      fps: FPS,
      fontName: fontOverride && FONT_RE.test(fontOverride) ? fontOverride : recipe.captions.fontFamily,
      fontSizePx: recipe.captions.fontSizePx,
      minFontSizePx: recipe.captions.minFontSizePx,
      maxLines: recipe.captions.maxLines,
      bold: recipe.captions.bold,
      textColor: colorOverride && HEX_RE.test(colorOverride) ? colorOverride : recipe.captions.textColor,
      highlightColor: recipe.captions.highlightColor,
      outlineColor: recipe.captions.outlineColor,
      outlinePx: recipe.captions.outlinePx,
      highlight: recipe.captions.highlight,
    };
    const cues = captionCuesFromComposePlan(plan);
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
