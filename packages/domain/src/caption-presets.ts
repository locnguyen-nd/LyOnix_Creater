/**
 * VE2E-94: built-in caption presets - ONE catalog for Auto (create video) and Studio (text style panel). A preset is only a set of
 * VE2E-93 caption style values the final renderers already draw; it adds no render capability. Every preset sets all style fields, so a
 * preset looks the same over any template.
 *
 * Choosing a preset stores its resolved VALUES in the timeline (plus the preset id, for the UI). Renderers never read this catalog: a
 * later change of a preset never changes a video that was already made. Pure, browser-safe (subpath `@lyonix/domain/caption-presets`).
 */
import { CAPTION_STYLE_CAPABILITIES, type CaptionStyleEngine, type CaptionStyleField, type CaptionStyleUnsupportedReason } from "./caption-style-capabilities.js";
import { CAPTION_PATCH_FIELD_CONTROL, CAPTION_PATCH_FIELDS, CAPTION_PRESET_OPTION_KEY, captionStylePatchToOptionValues, type CaptionPatchField, type CaptionTextStylePatch } from "./caption-style.js";

export const CAPTION_PRESET_CATEGORIES = ["clean", "news", "sports", "karaoke", "breaking"] as const;
export type CaptionPresetCategory = (typeof CAPTION_PRESET_CATEGORIES)[number];

/** A capability-map control, or `wordHighlight` (the per-word highlight animation). */
export type CaptionPresetCapability = CaptionStyleField | "wordHighlight";

export type CaptionPreset = {
  id: string;
  /** Bumped when a released preset's values change (stored videos keep their own values either way). */
  version: number;
  category: CaptionPresetCategory;
  /** i18n keys (apps/web locales). */
  nameKey: string;
  descriptionKey: string;
  /** Every caption style field (1080x1920 canvas pixels, `#RRGGBB`). */
  style: Required<CaptionTextStylePatch>;
  /** What the final renderer must support to draw this preset (checked against the capability map). */
  requiredCapabilities: readonly CaptionPresetCapability[];
};

const BASE_CAPABILITIES = ["font", "fontSize", "fillColor", "stroke", "position", "maxLines"] as const satisfies readonly CaptionPresetCapability[];

const preset = (id: string, category: CaptionPresetCategory, style: Required<CaptionTextStylePatch>): CaptionPreset => ({
  id,
  version: 1,
  category,
  nameKey: `captionPresets.items.${id}.name`,
  descriptionKey: `captionPresets.items.${id}.description`,
  style,
  requiredCapabilities: style.animation === "word_highlight" ? [...BASE_CAPABILITIES, "wordHighlight"] : [...BASE_CAPABILITIES],
});

const FONT = "noto-sans-jp";

export const CAPTION_PRESETS: readonly CaptionPreset[] = [
  preset("clean-white", "clean", { fontId: FONT, fontSizePx: 64, fillColor: "#FFFFFF", strokeEnabled: true, strokeColor: "#000000", strokeWidthPx: 4, position: "bottom", maxLines: 2, animation: "none" }),
  preset("news-bold", "news", { fontId: FONT, fontSizePx: 76, fillColor: "#FFFFFF", strokeEnabled: true, strokeColor: "#000000", strokeWidthPx: 8, position: "bottom", maxLines: 2, animation: "none" }),
  preset("sports-punch", "sports", { fontId: FONT, fontSizePx: 96, fillColor: "#FFE600", strokeEnabled: true, strokeColor: "#000000", strokeWidthPx: 10, position: "middle", maxLines: 1, animation: "none" }),
  preset("karaoke-highlight", "karaoke", { fontId: FONT, fontSizePx: 72, fillColor: "#FFFFFF", strokeEnabled: true, strokeColor: "#000000", strokeWidthPx: 6, position: "bottom", maxLines: 2, animation: "word_highlight" }),
  preset("minimal", "clean", { fontId: FONT, fontSizePx: 56, fillColor: "#FFFFFF", strokeEnabled: true, strokeColor: "#000000", strokeWidthPx: 2, position: "bottom", maxLines: 2, animation: "none" }),
  preset("breaking-red", "breaking", { fontId: FONT, fontSizePx: 80, fillColor: "#FFFFFF", strokeEnabled: true, strokeColor: "#E00000", strokeWidthPx: 10, position: "top", maxLines: 2, animation: "none" }),
];

const BY_ID = new Map(CAPTION_PRESETS.map((item) => [item.id, item]));

export const captionPresetById = (id: string | null | undefined): CaptionPreset | null => (id ? BY_ID.get(id) ?? null : null);

/** The capabilities a style really needs (what `requiredCapabilities` must declare). */
export function captionCapabilitiesForStyle(style: CaptionTextStylePatch): CaptionPresetCapability[] {
  const needed = new Set<CaptionPresetCapability>();
  for (const field of CAPTION_PATCH_FIELDS) {
    const value = style[field];
    if (value === undefined) continue;
    if (field === "animation") {
      if (value === "word_highlight") needed.add("wordHighlight");
    } else needed.add(CAPTION_PATCH_FIELD_CONTROL[field]);
  }
  return [...needed];
}

export type CaptionPresetSupport = { ok: true } | { ok: false; reason: CaptionStyleUnsupportedReason };

/** Whether the final renderer of `engine` draws this preset - read from the one capability map (no rule of its own). */
export function captionPresetSupport(engine: CaptionStyleEngine, item: CaptionPreset): CaptionPresetSupport {
  const capability = CAPTION_STYLE_CAPABILITIES[engine];
  if (!capability.editable) return { ok: false, reason: capability.reasons.all ?? "provider_unsupported" };
  for (const needed of item.requiredCapabilities) {
    if (needed === "wordHighlight") {
      if (!capability.animations.includes("word_highlight")) return { ok: false, reason: capability.reasons.animation ?? "provider_unsupported" };
    } else if (!capability.fields[needed]) return { ok: false, reason: capability.reasons[needed] ?? "provider_unsupported" };
  }
  return { ok: true };
}

/** The style change a preset makes (every field), as `{ field, value }` pairs. */
export const captionPresetChanges = (item: CaptionPreset): Array<{ field: CaptionPatchField; value: CaptionTextStylePatch[CaptionPatchField] }> =>
  CAPTION_PATCH_FIELDS.map((field) => ({ field, value: item.style[field] }));

/** Whole-video option values of a preset (resolved values + its id) - what Auto stores for the timeline it creates. */
export const captionPresetOptionValues = (item: CaptionPreset): Record<string, string> => ({ ...captionStylePatchToOptionValues(item.style), [CAPTION_PRESET_OPTION_KEY]: item.id });
