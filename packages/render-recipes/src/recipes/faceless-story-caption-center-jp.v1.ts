import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `faceless-story-caption-center-jp@1` (V04-01) - Japanese faceless story: full-bleed B-roll under a dark tint so the text stays readable,
 * a small headline near the top with a short rule under it, LARGE word-highlighted captions close to the centre of the frame (top anchor,
 * 38 % from the top), photos zoom out (direction alternates), clips push in lightly, 0.5 s fade between scenes. Built only from features
 * the internal engine already renders. Immutable once released: change = new version file.
 */
export const FACELESS_STORY_CAPTION_CENTER_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "faceless-story-caption-center-jp",
  version: 1,
  name: "Faceless story - caption center (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "fade", durationMs: 500 },
  background: {
    image: { motion: "zoom_out", intensity: 0.08, alternate: true },
    video: { motion: "zoom_in", intensity: 0.03 },
    tint: { color: "#000000", opacity: 0.3 },
  },
  layers: [
    {
      type: "text",
      id: "headline-text",
      slot: "headline",
      x: 130,
      y: 230,
      w: 820,
      h: 110,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 46,
      minFontSizePx: 30,
      color: "#FFFFFF",
      bold: true,
      maxLines: 2,
      outlinePx: 4,
      outlineColor: "#000000",
      visibleIfSlot: "headline",
    },
    { type: "box", id: "headline-rule", x: 490, y: 352, w: 100, h: 6, color: "#FFFFFF", opacity: 0.85, visibleIfSlot: "headline" },
  ],
  captions: {
    enabled: true,
    fontFamily: "Noto Sans CJK JP",
    fontSizePx: 76,
    minFontSizePx: 50,
    maxLines: 2,
    bold: true,
    textColor: "#FFFFFF",
    highlightColor: "#FFE600",
    outlineColor: "#000000",
    outlinePx: 8,
    highlight: "word",
    placement: { anchor: "top", marginPct: 38 },
  },
  audio: { musicBaseDb: -14, musicDuckDb: -26, duckRampMs: 250, loudnessLufs: -14, truePeakDb: -1.5 },
  slots: [{ key: "headline", kind: "text", label: "Headline (top)", required: false, default: "" }],
  fonts: ["Noto Sans CJK JP"],
};
