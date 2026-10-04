import { RECIPE_SCHEMA_VERSION, type RenderRecipe } from "../schema.js";

/**
 * `news-recap-broadcast-telop-jp@1` - Japanese news recap, "broadcast telop" look: red headline band with a yellow badge near the top (kept
 * below the TikTok top safe zone), voice-timed word-highlighted captions at the bottom (inside the bottom/side safe zones), image scenes with a
 * slow zoom, 0.4 s wipe between scenes. Approximates the Creatomate template of the same name from its description (fade/wipe/scale only);
 * pixel-parity is checked by the A/B in VE2E-116 on the owner's machine, which is why `rolloutPercent` stays 0 until it is approved.
 *
 * Released recipes are immutable: change the look by adding `.v2.ts`, never by editing this file (a test pins its digest).
 * Fonts: "Noto Sans CJK JP" (Debian `fonts-noto-cjk`, same typeface family as Google's Noto Sans JP; installed in the media-worker image).
 */
export const NEWS_RECAP_BROADCAST_TELOP_JP_V1: RenderRecipe = {
  schemaVersion: RECIPE_SCHEMA_VERSION,
  id: "news-recap-broadcast-telop-jp",
  version: 1,
  name: "News recap - broadcast telop (JP)",
  canvas: { width: 1080, height: 1920 },
  fps: 60,
  timing: { padStartMs: 300, padEndMs: 800 },
  transition: { kind: "wipe", durationMs: 400 },
  background: {
    image: { motion: "zoom_in", intensity: 0.06, alternate: true },
    video: { motion: "none", intensity: 0 },
    tint: { color: "#000000", opacity: 0.12 },
  },
  layers: [
    { type: "box", id: "telop-band", x: 0, y: 200, w: 1080, h: 210, color: "slot:accent", opacity: 0.94, visibleIfSlot: "headline" },
    { type: "box", id: "badge-box", x: 130, y: 214, w: 200, h: 56, color: "#FFD400", opacity: 1, visibleIfSlot: "badge" },
    {
      type: "text",
      id: "badge-text",
      slot: "badge",
      x: 130,
      y: 214,
      w: 200,
      h: 56,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 36,
      minFontSizePx: 24,
      color: "#1A1A1A",
      bold: true,
      maxLines: 1,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "badge",
    },
    {
      type: "text",
      id: "headline-text",
      slot: "headline",
      x: 130,
      y: 276,
      w: 820,
      h: 120,
      fontFamily: "Noto Sans CJK JP",
      fontSizePx: 60,
      minFontSizePx: 36,
      color: "#FFFFFF",
      bold: true,
      maxLines: 2,
      outlinePx: 0,
      outlineColor: "#000000",
      visibleIfSlot: "headline",
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
  slots: [
    { key: "headline", kind: "text", label: "Headline (telop band text)", required: false, default: "" },
    { key: "badge", kind: "text", label: "Badge text", required: false, default: "速報" },
    { key: "accent", kind: "color", label: "Band colour", required: false, default: "#C8102E" },
  ],
  fonts: ["Noto Sans CJK JP"],
};
