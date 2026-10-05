import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `news-recap-white-top-caption-jp@1` - Japanese news recap, "white top caption" look: a 44 %-tall picture band (centre of the canvas) on a near-black
 * canvas, a bold caption ABOVE the band whose colour alternates white/yellow per scene, a red "BREAKING NEWS" badge between caption and band,
 * 0.4 s wipe inside the band, slow zoom on photos. Approximates the Creatomate template "News Recap - White Top Caption (JP)" from its structure
 * (Video 100 % x 44 % centred, Subtitles at the top, alternating #ffffff/#ffe600, root badge): the template puts the caption at 6 % from the top, which
 * is inside TikTok's top UI zone, so this recipe sits it at 12 % (the safe-zone rule of the spec wins); pixel parity is for the A/B (VE2E-116).
 * Immutable once released: change = new version file.
 */
export const NEWS_RECAP_WHITE_TOP_CAPTION_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "news-recap-white-top-caption-jp",
  version: 1,
  name: "News recap - white top caption (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "wipe", durationMs: 400 },
  background: {
    image: { motion: "zoom_in", intensity: 0.05, alternate: true },
    video: { motion: "none", intensity: 0 },
    tint: { color: "#000000", opacity: 0.1 },
    frame: { mode: "band", heightPct: 44, centerYPct: 50, canvasColor: "#0B0B0B" },
  },
  layers: [
    { type: "box", id: "badge-box", x: 130, y: 432, w: 420, h: 64, color: "#D00000", opacity: 1, visibleIfSlot: "badge" },
    {
      type: "text",
      id: "badge-text",
      slot: "badge",
      x: 130,
      y: 432,
      w: 420,
      h: 64,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 34,
      minFontSizePx: 22,
      color: "#FFFFFF",
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
    fontSizePx: 66,
    minFontSizePx: 44,
    maxLines: 2,
    bold: true,
    textColor: "#FFFFFF",
    highlightColor: "#FFFFFF",
    outlineColor: "#000000",
    outlinePx: 12,
    highlight: "none",
    placement: { anchor: "top", marginPct: 12 },
    colorCycle: ["#FFFFFF", "#FFE600"],
  },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 250, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [{ key: "badge", kind: "text", label: "Badge text", required: false, default: "BREAKING NEWS" }],
  fonts: ["Noto Sans CJK JP"],
};
