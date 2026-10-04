import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `news-recap-photo-video-mix-jp@1` - Japanese news recap for a MIX of stock photos and video clips: full-bleed picture (photos get a slow zoom,
 * alternating direction; clips play as they are), a soft dark plate behind the lower third, word-highlighted captions (spoken words turn yellow),
 * a small yellow badge, 0.4 s fade between scenes. Approximation from the template's description (no JSON of the Creatomate original is available
 * in the cloud workspace): the look is plausible, NOT yet compared with the original - the A/B (VE2E-116) decides before any rollout.
 * Immutable once released: change = new version file.
 */
export const NEWS_RECAP_PHOTO_VIDEO_MIX_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "news-recap-photo-video-mix-jp",
  version: 1,
  name: "News recap - photo/video mix (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "fade", durationMs: 400 },
  background: {
    image: { motion: "zoom_in", intensity: 0.07, alternate: true },
    video: { motion: "none", intensity: 0 },
    tint: { color: "#000000", opacity: 0.08 },
  },
  layers: [
    { type: "box", id: "lower-plate", x: 0, y: 1330, w: 1080, h: 290, color: "#000000", opacity: 0.4 },
    { type: "box", id: "badge-box", x: 130, y: 214, w: 220, h: 56, color: "#FFD400", opacity: 1, visibleIfSlot: "badge" },
    {
      type: "text",
      id: "badge-text",
      slot: "badge",
      x: 130,
      y: 214,
      w: 220,
      h: 56,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 34,
      minFontSizePx: 22,
      color: "#1A1A1A",
      bold: true,
      maxLines: 1,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "badge",
    },
  ],
  captions: {
    enabled: true,
    fontFamily: "Noto Sans CJK JP",
    fontSizePx: 64,
    minFontSizePx: 44,
    maxLines: 2,
    bold: true,
    textColor: "#FFFFFF",
    highlightColor: "#FFD400",
    outlineColor: "#000000",
    outlinePx: 5,
    highlight: "word",
  },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 250, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [{ key: "badge", kind: "text", label: "Badge text", required: false, default: "NEWS" }],
  fonts: ["Noto Sans CJK JP"],
};
