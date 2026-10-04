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
export function layoutSceneCaption(caption: string, durationMs: number, recipe: RenderRecipe = NEWS_RECAP_BROADCAST_TELOP_JP_V1): PreviewCaptionPage[] {
  if (!caption.trim() || durationMs <= 0) return [];
  const { cues } = buildCaptionAss([{ text: caption, startMs: 0, endMs: durationMs }], captionStyle(recipe));
  return cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, lines: cue.lines, fontSizePx: cue.fontSizePx, split: cue.split }));
}

/** The page shown `offsetMs` into the scene (the last page stays until the scene ends). */
export function pageAt(pages: readonly PreviewCaptionPage[], offsetMs: number): PreviewCaptionPage | null {
  if (pages.length === 0) return null;
  return pages.find((page) => offsetMs >= page.startMs && offsetMs < page.endMs) ?? (offsetMs < pages[0]!.startMs ? pages[0]! : pages[pages.length - 1]!);
}

export function buildPreviewPlan(segments: readonly FullPreviewSegment[], recipe: RenderRecipe = NEWS_RECAP_BROADCAST_TELOP_JP_V1): PreviewPlan {
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
    })),
    profile: { padStartMs: recipe.timing.padStartMs, padEndMs: recipe.timing.padEndMs, defaultTransition: { kind: recipe.transition.kind, durationMs: recipe.transition.durationMs }, fps: PREVIEW_FPS },
  });
  const captionPages = new Map<string, PreviewCaptionPage[]>();
  for (const segment of segments) captionPages.set(segment.sceneId, layoutSceneCaption(segment.caption, segment.durationMs, recipe));
  return built.ok
    ? { renderPlan: built.plan, expectedRenderDurationMs: built.plan.totalDurationMs, skippedSceneIds: built.skippedSceneIds, captionPages }
    : { renderPlan: null, expectedRenderDurationMs: null, skippedSceneIds: segments.map((segment) => segment.sceneId), captionPages };
}
