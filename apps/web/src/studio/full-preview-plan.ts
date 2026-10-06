import { buildCaptionAss, type CaptionStyleOptions } from "@lyonix/domain/caption-ass";
import { buildRenderPlan, type RenderPlan } from "@lyonix/domain/render-plan";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1, type RenderRecipe } from "@lyonix/render-recipes";
import type { FullPreviewSegment } from "./full-preview";

/**
 * VE2E-114: ties the Studio full-preview to the internal render engine, so the preview answers "what will the render look like" with the SAME
 * code, not a look-alike:
 *  - timing: the preview sequence is turned into the engine's `RenderPlan` (frame-quantised 60 fps timeline, recipe padding), whose total is the
 *    expected render length;
 *  - captions: line breaks, font shrinking and cue splitting come from `buildCaptionAss` - the very function the media-worker uses to write the
 *    burned-in ASS - so a caption wraps in the preview exactly where it wraps in the video.
 * Still an approximation (no real TTS word timing, no transitions/tint/fonts), never render evidence; the player says so.
 */

export const PREVIEW_FPS = 60;

export type PreviewCaptionPage = {
  /** Relative to the scene start. */
  startMs: number;
  endMs: number;
  lines: string[];
  /** Font size on the 1080-wide canvas; the player scales it to its own width. */
  fontSizePx: number;
  /** True when the caption had to be split into several consecutive pages at the minimum font size. */
  split: boolean;
};

export type PreviewPlan = {
  /** The engine's plan for the scenes that have media + voice (what would actually render); `null` when none does. */
  renderPlan: RenderPlan | null;
  /** Total length of that render incl. head/tail padding (ms) - `null` when no scene is renderable yet. */
  expectedRenderDurationMs: number | null;
  /** Scenes the engine would skip (no media or no voice yet). */
  skippedSceneIds: string[];
  captionPages: Map<string, PreviewCaptionPage[]>;
};

const captionStyle = (recipe: RenderRecipe): CaptionStyleOptions => ({
  canvas: { width: recipe.canvas.width, height: recipe.canvas.height },
  fps: PREVIEW_FPS,
  fontName: recipe.captions.fontFamily,
  fontSizePx: recipe.captions.fontSizePx,
  minFontSizePx: recipe.captions.minFontSizePx,
  maxLines: recipe.captions.maxLines,
  bold: recipe.captions.bold,
  textColor: recipe.captions.textColor,
  highlightColor: recipe.captions.highlightColor,
  outlineColor: recipe.captions.outlineColor,
  outlinePx: recipe.captions.outlinePx,
  highlight: "none",
});

/** Caption pages of ONE scene exactly as the render lays them out (shared `buildCaptionAss`); a scene without caption has none. */
export function layoutSceneCaption(caption: string, durationMs: number, recipe: RenderRecipe = NEWS_RECAP_BROADCAST_TELOP_JP_V1, options?: CaptionStyleOptions): PreviewCaptionPage[] {
  if (!caption.trim() || durationMs <= 0) return [];
  const { cues } = buildCaptionAss([{ text: caption, startMs: 0, endMs: durationMs }], options ? { ...options, fps: PREVIEW_FPS } : captionStyle(recipe));
  return cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, lines: cue.lines, fontSizePx: cue.fontSizePx, split: cue.split }));
}

/**
 * V03-03: caption pages of ONE scene from its voice-timed cues (what the render burns in when the scene has them), laid out by the
 * same shared `buildCaptionAss`. Cues are clamped to the scene; a cue the scene is too short for is dropped.
 */
export function layoutSceneCues(cues: ReadonlyArray<{ text: string; startMs: number; endMs: number }>, durationMs: number, recipe: RenderRecipe = NEWS_RECAP_BROADCAST_TELOP_JP_V1, options?: CaptionStyleOptions): PreviewCaptionPage[] {
  if (durationMs <= 0) return [];
  const usable = cues
    .map((cue) => ({ text: cue.text, startMs: Math.max(0, cue.startMs), endMs: Math.min(durationMs, cue.endMs) }))
    .filter((cue) => cue.text.trim() && cue.endMs > cue.startMs);
  if (usable.length === 0) return [];
  const { cues: laidOut } = buildCaptionAss(usable, options ? { ...options, fps: PREVIEW_FPS } : captionStyle(recipe));
  return laidOut.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, lines: cue.lines, fontSizePx: cue.fontSizePx, split: cue.split }));
}

/**
 * The page shown `offsetMs` into the scene: the page covering it, else the latest page already started (V03-03: holds a voice-timed
 * cue through a pause instead of jumping ahead), else the first one. The last page stays until the scene ends.
 */
export function pageAt(pages: readonly PreviewCaptionPage[], offsetMs: number): PreviewCaptionPage | null {
  if (pages.length === 0) return null;
  const covering = pages.find((page) => offsetMs >= page.startMs && offsetMs < page.endMs);
  if (covering) return covering;
  const started = pages.filter((page) => page.startMs <= offsetMs);
  return started.length > 0 ? started[started.length - 1]! : pages[0]!;
}

/**
 * VE2E-93: `captionOptions` gives the layout options of each scene's EFFECTIVE caption style (`captionLayoutOptions`); a scene without
 * one is laid out with the recipe's caption style as before.
 */
export function buildPreviewPlan(segments: readonly FullPreviewSegment[], recipe: RenderRecipe = NEWS_RECAP_BROADCAST_TELOP_JP_V1, captionOptions?: (sceneId: string) => CaptionStyleOptions | undefined): PreviewPlan {
  const built = buildRenderPlan({
    scenes: segments.map((segment) => ({
      sceneId: segment.sceneId,
      orderIndex: segment.index,
      // opaque ids: the preview has signed URLs, not asset-version ids - the plan only needs to know media/voice exist
      mediaAssetVersionId: segment.missingMedia ? null : `media:${segment.sceneId}`,
      mediaKind: segment.mediaKind,
      audioAssetVersionId: segment.missingVoice ? null : `voice:${segment.sceneId}`,
      // the voice length is what drives a scene's length in the render
      audioDurationMs: segment.durationSource === "audio" ? segment.durationMs : null,
      fallbackScreenText: segment.caption,
      captionSegments: segment.captionCues ?? null,
    })),
    profile: { padStartMs: recipe.timing.padStartMs, padEndMs: recipe.timing.padEndMs, defaultTransition: { kind: recipe.transition.kind, durationMs: recipe.transition.durationMs }, fps: PREVIEW_FPS },
  });
  const captionPages = new Map<string, PreviewCaptionPage[]>();
  for (const segment of segments) {
    const options = captionOptions?.(segment.sceneId);
    const cuePages = segment.captionCues ? layoutSceneCues(segment.captionCues, segment.durationMs, recipe, options) : [];
    captionPages.set(segment.sceneId, cuePages.length > 0 ? cuePages : layoutSceneCaption(segment.caption, segment.durationMs, recipe, options));
  }
  return built.ok
    ? { renderPlan: built.plan, expectedRenderDurationMs: built.plan.totalDurationMs, skippedSceneIds: built.skippedSceneIds, captionPages }
    : { renderPlan: null, expectedRenderDurationMs: null, skippedSceneIds: segments.map((segment) => segment.sceneId), captionPages };
}
