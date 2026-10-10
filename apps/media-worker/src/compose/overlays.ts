import {
  assOverrideColor,
  buildCaptionAss,
  captionAssStyle,
  captionDefaultsFromRecipeCaptions,
  captionStyleFromOptionValues,
  legacyCaptionFontFamily,
  formatAssTime,
  resolveCaptionTextStyle,
  snapToFrameMs,
  type CaptionCueInput,
  type CaptionCueStyle,
  type CaptionStyleOptions,
  type CaptionTextStyle,
} from "@lyonix/domain";
import type { ComposePlan } from "@lyonix/media-jobs";
import { CAPTION_MOTION, LAYER_EXIT_FADE_MS, layerMotionFor, resolveRecipeParams, type LayerMotion, type RecipeBoxLayer, type RenderRecipe } from "@lyonix/render-recipes";
import { FPS } from "./filtergraph.js";

/**
 * VE2E-105: ASS documents for the burned-in text of a render (voice-timed captions + recipe text layers), produced with the same
 * `buildCaptionAss` the Studio player uses so line breaks match the preview. Pure.
 *
 * VE2E-93: the caption style is resolved with the shared `@lyonix/domain/caption-style` rules - recipe default <- whole-video style
 * (`plan.params`) <- scene override (`scene.captionParams`); a scene with its own style gets its own ASS style.
 *
 * VE2E-157 (`compose.v2`): every overlay moves the way the shared motion preset (`@lyonix/render-recipes` motion.ts) says, drawn by libass in
 * the MP4: recipe boxes are ASS drawings (not static `drawbox`) so a band / badge / rule enters together with its text; the headline fades in
 * while rising, the badge pops, panels are revealed from the left, rules grow; every layer fades out at the very end; each caption phrase
 * appears with a short fade + pop when its voice starts.
 */

const frameMs = (frame: number): number => (frame * 1000) / FPS;

export type OverlayDocuments = {
  captions: { ass: string; warnings: string[]; cueCount: number } | null;
  /** One document per visible recipe layer (box or text), in the recipe's drawing order. */
  layers: Array<{ layerId: string; ass: string; text: string; kind: "box" | "text"; motion: LayerMotion }>;
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

const BOX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Colour of a box: a literal `#RRGGBB`, or `slot:<key>` resolved from the slot value / its default (black when neither is a colour). */
export function boxColor(layer: RecipeBoxLayer, recipe: RenderRecipe, params: Record<string, string>): string {
  if (BOX_COLOR_RE.test(layer.color)) return layer.color;
  const key = layer.color.replace(/^slot:/, "");
  const value = params[key] ?? "";
  if (BOX_COLOR_RE.test(value)) return value;
  const fallback = recipe.slots.find((slot) => slot.key === key)?.default ?? "";
  return BOX_COLOR_RE.test(fallback) ? fallback : "#000000";
}

/** Fade-out at the end of the video, never overlapping the entrance of a (very short) video. */
const exitFadeMs = (motion: LayerMotion, totalMs: number): number => Math.max(0, Math.min(LAYER_EXIT_FADE_MS, Math.round(totalMs - motion.delayMs - motion.fadeInMs)));

/**
 * VE2E-157: one recipe box as an animated ASS drawing (libass). Geometry and colour are the recipe's; the entrance comes from `motion`:
 * grow `x` from the left edge (`\an7`), grow `y` from the top edge (`\an8`), otherwise centred (`\an5`) with pop and/or rise.
 */
export function boxLayerAss(layer: RecipeBoxLayer, color: string, motion: LayerMotion, totalMs: number, canvas = { width: 1080, height: 1920 }): string {
  const startMs = snapToFrameMs(motion.delayMs, FPS);
  const endMs = Math.max(startMs + 1000 / FPS, snapToFrameMs(totalMs, FPS));
  const alpha = Math.round((1 - Math.max(0, Math.min(1, layer.opacity))) * 255).toString(16).toUpperCase().padStart(2, "0");
  const cx = Math.round(layer.x + layer.w / 2);
  const cy = Math.round(layer.y + layer.h / 2);
  const scaleMs = Math.round(motion.scaleMs);
  let position: string;
  let scale = "";
  if (motion.grow === "x") {
    position = `\\an7\\pos(${Math.round(layer.x)},${Math.round(layer.y)})`;
    scale = `\\fscx0\\t(0,${scaleMs},\\fscx100)`;
  } else if (motion.grow === "y") {
    position = `\\an8\\pos(${cx},${Math.round(layer.y)})`;
    scale = `\\fscy0\\t(0,${scaleMs},\\fscy100)`;
  } else {
    position = motion.risePx !== 0 ? `\\an5\\move(${cx},${cy + Math.round(motion.risePx)},${cx},${cy},0,${Math.max(1, Math.round(motion.fadeInMs))})` : `\\an5\\pos(${cx},${cy})`;
    if (motion.popFromPct !== 100 && scaleMs > 0) scale = `\\fscx${motion.popFromPct}\\fscy${motion.popFromPct}\\t(0,${scaleMs},\\fscx100\\fscy100)`;
  }
  const tags = [position, "\\bord0", "\\shad0", `\\1c${assOverrideColor(color)}`, `\\1a&H${alpha}&`, `\\fad(${Math.round(motion.fadeInMs)},${exitFadeMs(motion, totalMs)})`, scale];
  const w = Math.round(layer.w);
  const h = Math.round(layer.h);
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Box,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    `Dialogue: 0,${formatAssTime(startMs)},${formatAssTime(endMs)},Box,,0,0,0,,{${tags.join("")}\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}{\\p0}`,
    "",
  ].join("\n");
}

export function buildOverlayDocuments(plan: ComposePlan, recipe: RenderRecipe, rawParams: Record<string, string>): OverlayDocuments {
  const params = resolveRecipeParams(recipe, rawParams);
  const warnings: string[] = [];
  const canvas = { width: 1080, height: 1920 };

  let captions: OverlayDocuments["captions"] = null;
  if (recipe.captions.enabled) {
    const styles = captionStylesForPlan(plan, recipe, rawParams);
    const style: CaptionStyleOptions = { canvas, fps: FPS, ...captionAssStyle(styles.global), entrance: { fadeInMs: CAPTION_MOTION.fadeInMs, popFromPct: CAPTION_MOTION.popFromPct, popMs: CAPTION_MOTION.popMs } };
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
    if (layer.visibleIfSlot && !(params[layer.visibleIfSlot] ?? "").trim()) continue;
    const motion = layerMotionFor(layer);
    if (layer.type === "box") {
      layers.push({ layerId: layer.id, ass: boxLayerAss(layer, boxColor(layer, recipe, params), motion, totalMs, canvas), text: "", kind: "box", motion });
      continue;
    }
    const text = (params[layer.slot] ?? "").trim();
    if (!text) continue;
    const built = buildCaptionAss([{ text, startMs: motion.delayMs, endMs: totalMs }], {
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
      entrance: { fadeInMs: motion.fadeInMs, fadeOutMs: exitFadeMs(motion, totalMs), risePx: motion.risePx, popFromPct: motion.popFromPct, popMs: motion.scaleMs },
    });
    layers.push({ layerId: layer.id, ass: built.ass, text, kind: "text", motion });
    warnings.push(...built.warnings);
  }
  return { captions, layers, params, warnings };
}
