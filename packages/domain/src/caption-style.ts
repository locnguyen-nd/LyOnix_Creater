/**
 * VE2E-93: the canonical caption (subtitle) text style of a timeline, shared by Studio (panel + preview), the API (validation) and both
 * render paths (LyOnix ASS, Creatomate dynamic composition) so they all read the same values the same way.
 *
 *   effective style of a scene = scene override  >  whole-video (global) style  >  template default  >  system default
 *
 * - Global style: flat `dynamicStyle.caption*` keys in `TimelineVersion.optionValues` (same storage as the VE2E-26 overrides; the two
 *   VE2E-26 keys `captionFontFamily` (legacy, read-only) and `captionFillColor` keep working).
 * - Scene override: `captionStyleOverride` on the scene binding (JSON in `TimelineVersion.scenes`), only the fields that differ.
 * - Only what the engines really render (spec .docs/specs/VE2E-93.md); never more than 2 caption lines (V03-03).
 *
 * Pure, browser-safe (subpath `@lyonix/domain/caption-style`).
 */
import { CAPTION_SAFE_ZONE, type CaptionCueStyle, type CaptionStyleOptions } from "./caption-ass.js";
import { captionFontByFamily, captionFontById } from "./caption-fonts.js";
import { CAPTION_ANIMATIONS, CAPTION_STYLE_CAPABILITIES, type CaptionAnimation, type CaptionStyleEngine, type CaptionStyleField } from "./caption-style-capabilities.js";

export const CAPTION_POSITION_PRESETS = ["top", "middle", "bottom"] as const;
export type CaptionPositionPreset = (typeof CAPTION_POSITION_PRESETS)[number];
export type CaptionAnchor = "top" | "center" | "bottom";
/** `top`/`bottom`: distance (% of the canvas height) between that edge and the caption block; `center`: the block's centre line. */
export type CaptionPosition = { anchor: CaptionAnchor; percent: number };

/** Preset -> placement. Top/bottom sit on the TikTok safe zone edges (caption-ass `CAPTION_SAFE_ZONE`). */
export const CAPTION_POSITION_LAYOUT: Readonly<Record<CaptionPositionPreset, CaptionPosition>> = {
  top: { anchor: "top", percent: 10 },
  middle: { anchor: "center", percent: 50 },
  bottom: { anchor: "bottom", percent: 20 },
};

/** Canvas-pixel ranges on the 1080x1920 reference canvas. */
export const CAPTION_FONT_SIZE_RANGE = { min: 32, max: 128, step: 2 } as const;
export const CAPTION_STROKE_WIDTH_RANGE = { min: 1, max: 20, step: 1 } as const;
export const CAPTION_MAX_LINE_OPTIONS = [1, 2] as const;
export type CaptionMaxLines = (typeof CAPTION_MAX_LINE_OPTIONS)[number];
/** Stroke width used when the user turns the stroke on over a template that has none. */
export const DEFAULT_CAPTION_STROKE_WIDTH_PX = 5;

/** Creatomate text boxes wrap by themselves; the caption pages are laid out with this margin and box width (caption-pages.ts). */
export const CREATOMATE_CAPTION_WIDTH_SAFETY = 0.82;
export const CREATOMATE_DEFAULT_CAPTION_WIDTH_FRACTION = 0.86;

export type CaptionTextStylePatch = {
  fontId?: string;
  fontSizePx?: number;
  fillColor?: string;
  strokeEnabled?: boolean;
  strokeColor?: string;
  strokeWidthPx?: number;
  position?: CaptionPositionPreset;
  maxLines?: CaptionMaxLines;
  animation?: CaptionAnimation;
};
export type CaptionPatchField = keyof CaptionTextStylePatch;
export const CAPTION_PATCH_FIELDS: readonly CaptionPatchField[] = ["fontId", "fontSizePx", "fillColor", "strokeEnabled", "strokeColor", "strokeWidthPx", "position", "maxLines", "animation"];

/** The capability-map control a patch field belongs to. */
export const CAPTION_PATCH_FIELD_CONTROL: Readonly<Record<CaptionPatchField, CaptionStyleField>> = {
  fontId: "font",
  fontSizePx: "fontSize",
  fillColor: "fillColor",
  strokeEnabled: "stroke",
  strokeColor: "stroke",
  strokeWidthPx: "stroke",
  position: "position",
  maxLines: "maxLines",
  animation: "animation",
};

/** Template defaults in canonical units (the API computes them for the pinned template: LyOnix recipe / Creatomate template). */
export type CaptionTemplateDefaults = {
  /** Font family name as the template's engine knows it. */
  fontFamily: string;
  fontSizePx: number;
  /** LyOnix shrinks a long caption down to this size before splitting it; Creatomate never shrinks (= fontSizePx). */
  minFontSizePx: number;
  bold: boolean;
  fillColor: string;
  /** Colour of the already-spoken words (word highlight); null when the template has none. */
  highlightColor: string | null;
  stroke: { enabled: boolean; color: string; widthPx: number };
  position: CaptionPosition;
  maxLines: CaptionMaxLines;
  animation: CaptionAnimation;
  /** LyOnix recipes that colour each scene's caption in turn (V04-01); null = none. */
  colorCycle: string[] | null;
};

/** Used when no template default is known (`caption-ass` defaults, without the word highlight). */
export const SYSTEM_CAPTION_DEFAULTS: CaptionTemplateDefaults = {
  fontFamily: "Noto Sans CJK JP",
  fontSizePx: 64,
  minFontSizePx: 44,
  bold: true,
  fillColor: "#FFFFFF",
  highlightColor: "#FFD400",
  stroke: { enabled: true, color: "#000000", widthPx: 5 },
  position: { anchor: "bottom", percent: 20 },
  maxLines: 2,
  animation: "none",
  colorCycle: null,
};

export type CaptionFontSource = "catalog" | "legacy" | "template";

/** Effective style of one scene. */
export type CaptionTextStyle = Omit<CaptionTemplateDefaults, "fontFamily" | "position"> & {
  font: { id: string | null; family: string; source: CaptionFontSource; inCatalog: boolean };
  position: CaptionPosition & { preset: CaptionPositionPreset | null };
  /** D3: the fill colour was set by the user (global or scene) - it then wins over the recipe's `colorCycle`. */
  fillColorFromUser: boolean;
};

// ---------------------------------------------------------------------------------------------------------------------
// values

const FONT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ALPHA_HEX_RE = /^#([0-9a-fA-F]{4}|[0-9a-fA-F]{8})$/;

/** `#RGB`/`#RRGGBB` -> `#RRGGBB` (case kept); anything else (incl. colours with alpha) -> null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!HEX_RE.test(trimmed)) return null;
  return trimmed.length === 4 ? `#${[...trimmed.slice(1)].map((ch) => ch + ch).join("")}` : trimmed;
}

export const isAlphaHexColor = (value: unknown): boolean => typeof value === "string" && ALPHA_HEX_RE.test(value.trim());

const toInt = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(number) ? number : null;
};

const toBool = (value: unknown): boolean | null => (value === true || value === "true" ? true : value === false || value === "false" ? false : null);

/** One patch field from a stored value (typed JSON or an option-value string); undefined when missing or invalid. */
export function parseCaptionPatchValue<F extends CaptionPatchField>(field: F, raw: unknown): CaptionTextStylePatch[F] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let value: unknown;
  switch (field) {
    case "fontId":
      value = typeof raw === "string" && FONT_ID_RE.test(raw) ? raw : undefined;
      break;
    case "fontSizePx": {
      const size = toInt(raw);
      value = size !== null && size >= CAPTION_FONT_SIZE_RANGE.min && size <= CAPTION_FONT_SIZE_RANGE.max ? size : undefined;
      break;
    }
    case "strokeWidthPx": {
      const width = toInt(raw);
      value = width !== null && width >= CAPTION_STROKE_WIDTH_RANGE.min && width <= CAPTION_STROKE_WIDTH_RANGE.max ? width : undefined;
      break;
    }
    case "fillColor":
    case "strokeColor":
      value = normalizeHexColor(raw) ?? undefined;
      break;
    case "strokeEnabled":
      value = toBool(raw) ?? undefined;
      break;
    case "position":
      value = typeof raw === "string" && (CAPTION_POSITION_PRESETS as readonly string[]).includes(raw) ? raw : undefined;
      break;
    case "maxLines": {
      const lines = toInt(raw);
      value = lines === 1 || lines === 2 ? lines : undefined;
      break;
    }
    case "animation":
      value = typeof raw === "string" && (CAPTION_ANIMATIONS as readonly string[]).includes(raw) ? raw : undefined;
      break;
  }
  return value as CaptionTextStylePatch[F] | undefined;
}

/** Drops unknown/invalid fields of a stored scene override (never throws); null when nothing valid is left. */
export function normalizeCaptionTextStylePatch(raw: unknown): CaptionTextStylePatch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const patch: CaptionTextStylePatch = {};
  for (const field of CAPTION_PATCH_FIELDS) {
    const value = parseCaptionPatchValue(field, input[field]);
    if (value !== undefined) (patch as Record<string, unknown>)[field] = value;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Save-time validation of a scene override: unknown keys or invalid values are errors (the API rejects the save). */
export function validateCaptionTextStylePatch(raw: unknown): { ok: true; value: CaptionTextStylePatch | null } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["captionStyleOverride phải là object"] };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(CAPTION_PATCH_FIELDS as readonly string[]).includes(key)) errors.push(`field không hỗ trợ: ${key}`);
    else if (value !== undefined && value !== null && parseCaptionPatchValue(key as CaptionPatchField, value) === undefined) errors.push(`giá trị không hợp lệ: ${key}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: normalizeCaptionTextStylePatch(raw) };
}

// ---------------------------------------------------------------------------------------------------------------------
// global style <-> optionValues

/** Flat option keys of the global style. `fillColor` reuses the VE2E-26 key. */
export const CAPTION_STYLE_OPTION_KEYS: Readonly<Record<CaptionPatchField, string>> = {
  fontId: "dynamicStyle.captionFontId",
  fontSizePx: "dynamicStyle.captionFontSizePx",
  fillColor: "dynamicStyle.captionFillColor",
  strokeEnabled: "dynamicStyle.captionStrokeEnabled",
  strokeColor: "dynamicStyle.captionStrokeColor",
  strokeWidthPx: "dynamicStyle.captionStrokeWidthPx",
  position: "dynamicStyle.captionPosition",
  maxLines: "dynamicStyle.captionMaxLines",
  animation: "dynamicStyle.captionAnimation",
};
/** VE2E-26 free-text font name: still honoured when no `captionFontId` is set, never written by VE2E-93 (cleared by an explicit font choice). */
export const LEGACY_CAPTION_FONT_FAMILY_KEY = "dynamicStyle.captionFontFamily";

const CAPTION_OPTION_KEY_TO_FIELD = new Map(Object.entries(CAPTION_STYLE_OPTION_KEYS).map(([field, key]) => [key, field as CaptionPatchField]));

export const isCaptionStyleOptionKey = (key: string): boolean => CAPTION_OPTION_KEY_TO_FIELD.has(key) || key === LEGACY_CAPTION_FONT_FAMILY_KEY;

/** VE2E-26 rules, unchanged: Creatomate-safe font name (<= 60 chars) and any `#RGB/#RGBA/#RRGGBB/#RRGGBBAA` fill colour. */
const LEGACY_FONT_RE = /^[A-Za-z0-9 _-]+$/;
const LEGACY_FONT_MAX_LENGTH = 60;

/**
 * Save-time validation of one global caption option value. `""` always means "inherit". The two VE2E-26 keys keep their original rules
 * so no timeline saved before VE2E-93 ever fails to re-save.
 */
export function isValidCaptionStyleOptionValue(key: string, value: string): boolean {
  if (value === "") return isCaptionStyleOptionKey(key);
  if (key === LEGACY_CAPTION_FONT_FAMILY_KEY) return value.trim().length > 0 && value.length <= LEGACY_FONT_MAX_LENGTH && LEGACY_FONT_RE.test(value);
  if (key === CAPTION_STYLE_OPTION_KEYS.fillColor) return normalizeHexColor(value) !== null || isAlphaHexColor(value);
  const field = CAPTION_OPTION_KEY_TO_FIELD.get(key);
  return field !== undefined && parseCaptionPatchValue(field, value) !== undefined;
}

export type CaptionStyleIssue =
  | { kind: "legacy_font"; family: string }
  | { kind: "alpha_color"; value: string }
  | { kind: "unknown_font"; fontId: string };

/** The global patch stored in `optionValues`, the legacy font name (raw) and what the user should be told about the stored values. */
export function captionStyleFromOptionValues(values: Readonly<Record<string, string>> | null | undefined): { patch: CaptionTextStylePatch; legacyFontFamily: string | null; issues: CaptionStyleIssue[] } {
  const source = values ?? {};
  const patch: CaptionTextStylePatch = {};
  for (const field of CAPTION_PATCH_FIELDS) {
    const value = parseCaptionPatchValue(field, source[CAPTION_STYLE_OPTION_KEYS[field]]);
    if (value !== undefined) (patch as Record<string, unknown>)[field] = value;
  }
  const issues: CaptionStyleIssue[] = [];
  const legacy = source[LEGACY_CAPTION_FONT_FAMILY_KEY]?.trim() ? source[LEGACY_CAPTION_FONT_FAMILY_KEY]! : null;
  if (patch.fontId && !captionFontById(patch.fontId)) issues.push({ kind: "unknown_font", fontId: patch.fontId });
  if (legacy && !(patch.fontId && captionFontById(patch.fontId))) issues.push({ kind: "legacy_font", family: legacy.trim() });
  const fill = source[CAPTION_STYLE_OPTION_KEYS.fillColor];
  if (fill && isAlphaHexColor(fill)) issues.push({ kind: "alpha_color", value: fill });
  return { patch, legacyFontFamily: legacy, issues };
}

/** Scene override -> flat option values (the per-scene params a LyOnix compose job carries). */
export function captionStylePatchToOptionValues(patch: CaptionTextStylePatch | null | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of CAPTION_PATCH_FIELDS) {
    const value = patch?.[field];
    if (value !== undefined) values[CAPTION_STYLE_OPTION_KEYS[field]] = String(value);
  }
  return values;
}

/** Sets (or, with `undefined`, removes) one global field in `optionValues`. Choosing a font always retires the legacy font name. */
export function setCaptionStyleOptionValue(values: Readonly<Record<string, string>>, field: CaptionPatchField, value: CaptionTextStylePatch[CaptionPatchField] | undefined): Record<string, string> {
  const next = { ...values };
  const key = CAPTION_STYLE_OPTION_KEYS[field];
  if (value === undefined) delete next[key];
  else next[key] = String(value);
  if (field === "fontId") delete next[LEGACY_CAPTION_FONT_FAMILY_KEY];
  return next;
}

/** "Reset whole video to the template default": removes every caption style key (the VE2E-26 ones included). */
export function clearCaptionStyleOptionValues(values: Readonly<Record<string, string>>): Record<string, string> {
  const next = { ...values };
  for (const key of Object.values(CAPTION_STYLE_OPTION_KEYS)) delete next[key];
  delete next[LEGACY_CAPTION_FONT_FAMILY_KEY];
  return next;
}

/** The legacy font name as the given engine applied it before VE2E-93 (LyOnix trims and allows any letters; Creatomate the raw value). */
export function legacyCaptionFontFamily(engine: CaptionStyleEngine, raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (engine === "lyonix") {
    const trimmed = raw.trim();
    return trimmed && /^[\p{L}\p{N} ._-]{1,80}$/u.test(trimmed) ? trimmed : null;
  }
  if (engine === "creatomate") return raw.trim().length > 0 && raw.length <= LEGACY_FONT_MAX_LENGTH && LEGACY_FONT_RE.test(raw) ? raw : null;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// resolution

export type ResolveCaptionStyleInput = {
  engine: CaptionStyleEngine;
  defaults?: CaptionTemplateDefaults | null | undefined;
  global?: CaptionTextStylePatch | null | undefined;
  /** Legacy (VE2E-26) font name, already checked with `legacyCaptionFontFamily` for this engine. */
  legacyFontFamily?: string | null | undefined;
  scene?: CaptionTextStylePatch | null | undefined;
};

const presetMatching = (position: CaptionPosition): CaptionPositionPreset | null =>
  CAPTION_POSITION_PRESETS.find((preset) => CAPTION_POSITION_LAYOUT[preset].anchor === position.anchor && Math.abs(CAPTION_POSITION_LAYOUT[preset].percent - position.percent) < 0.001) ?? null;

export function resolveCaptionTextStyle(input: ResolveCaptionStyleInput): CaptionTextStyle {
  const d = input.defaults ?? SYSTEM_CAPTION_DEFAULTS;
  const global = input.global ?? {};
  const scene = input.scene ?? {};
  const pick = <F extends CaptionPatchField>(field: F): CaptionTextStylePatch[F] => (scene[field] !== undefined ? scene[field] : global[field]);
  const familyOf = (font: NonNullable<ReturnType<typeof captionFontById>>) => (input.engine === "creatomate" ? font.families.creatomate : font.families.lyonix);

  const chosen = captionFontById(scene.fontId) ?? captionFontById(global.fontId);
  let font: CaptionTextStyle["font"];
  if (chosen) font = { id: chosen.id, family: familyOf(chosen), source: "catalog", inCatalog: true };
  else if (input.legacyFontFamily) {
    const entry = captionFontByFamily(input.legacyFontFamily);
    font = { id: entry?.id ?? null, family: input.legacyFontFamily, source: "legacy", inCatalog: Boolean(entry) };
  } else {
    const entry = captionFontByFamily(d.fontFamily);
    font = { id: entry?.id ?? null, family: d.fontFamily, source: "template", inCatalog: Boolean(entry) };
  }

  const fontSizePx = pick("fontSizePx") ?? d.fontSizePx;
  const fill = pick("fillColor");
  const preset = pick("position");
  const position = preset ? { preset, ...CAPTION_POSITION_LAYOUT[preset] } : { ...d.position, preset: null };
  return {
    font,
    fontSizePx,
    minFontSizePx: Math.min(d.minFontSizePx, fontSizePx),
    bold: d.bold,
    fillColor: fill ?? d.fillColor,
    fillColorFromUser: fill !== undefined,
    highlightColor: d.highlightColor,
    stroke: {
      enabled: pick("strokeEnabled") ?? d.stroke.enabled,
      color: pick("strokeColor") ?? d.stroke.color,
      widthPx: pick("strokeWidthPx") ?? d.stroke.widthPx,
    },
    position,
    maxLines: pick("maxLines") ?? d.maxLines,
    animation: pick("animation") ?? d.animation,
    colorCycle: d.colorCycle,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// editing

/** The value a patch field has in a resolved style - what the user sees for it (a template placement equal to a preset counts as it). */
export function captionStyleFieldValue<F extends CaptionPatchField>(style: CaptionTextStyle, field: F): CaptionTextStylePatch[F] | null {
  const values: { [K in CaptionPatchField]: CaptionTextStylePatch[K] | null } = {
    fontId: style.font.id,
    fontSizePx: style.fontSizePx,
    fillColor: style.fillColor,
    strokeEnabled: style.stroke.enabled,
    strokeColor: style.stroke.color,
    strokeWidthPx: style.stroke.widthPx,
    position: style.position.preset ?? presetMatching(style.position),
    maxLines: style.maxLines,
    animation: style.animation,
  };
  return values[field] as CaptionTextStylePatch[F] | null;
}

const sameValue = (field: CaptionPatchField, a: unknown, b: unknown): boolean =>
  field === "fillColor" || field === "strokeColor" ? typeof a === "string" && typeof b === "string" && normalizeHexColor(a)?.toLowerCase() === normalizeHexColor(b)?.toLowerCase() : a === b;

/**
 * Writes one field of a scope's patch. `undefined`, or a value equal to what the scope inherits (`inherited` = the style resolved
 * WITHOUT this scope), removes the field - a patch only ever stores differences. Returns null when the patch is left empty.
 */
export function applyCaptionStyleEdit<F extends CaptionPatchField>(
  patch: CaptionTextStylePatch | null | undefined,
  field: F,
  value: CaptionTextStylePatch[F] | undefined,
  inherited: CaptionTextStyle,
): CaptionTextStylePatch | null {
  const next: CaptionTextStylePatch = { ...(patch ?? {}) };
  const parsed = value === undefined ? undefined : parseCaptionPatchValue(field, value);
  if (parsed === undefined || sameValue(field, parsed, captionStyleFieldValue(inherited, field))) delete next[field];
  else next[field] = parsed;
  return Object.keys(next).length > 0 ? next : null;
}

/** "Reset this scene to the whole-video style". */
export const clearSceneCaptionStyle = (): null => null;

/** Fields of a stored patch the engine would not apply (shown as a warning; Orshot: every field). */
export function unsupportedCaptionPatchFields(engine: CaptionStyleEngine, patch: CaptionTextStylePatch | null | undefined): CaptionPatchField[] {
  if (!patch) return [];
  const capability = CAPTION_STYLE_CAPABILITIES[engine];
  return CAPTION_PATCH_FIELDS.filter((field) => {
    const value = patch[field];
    if (value === undefined) return false;
    if (!capability.editable) return true;
    if (field === "animation") return !capability.animations.includes(value as CaptionAnimation);
    return !capability.fields[CAPTION_PATCH_FIELD_CONTROL[field]];
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// template defaults + layout

/** Structural view of a LyOnix recipe's `captions` block (packages/render-recipes) - kept structural so domain needs no dependency. */
export type RecipeCaptionsLike = {
  fontFamily: string;
  fontSizePx: number;
  minFontSizePx: number;
  maxLines: number;
  bold: boolean;
  textColor: string;
  highlightColor: string;
  outlineColor: string;
  outlinePx: number;
  highlight: "word" | "none";
  placement?: { anchor: "top" | "bottom"; marginPct: number } | undefined;
  colorCycle?: readonly string[] | undefined;
};

export function captionDefaultsFromRecipeCaptions(captions: RecipeCaptionsLike): CaptionTemplateDefaults {
  return {
    fontFamily: captions.fontFamily,
    fontSizePx: captions.fontSizePx,
    minFontSizePx: captions.minFontSizePx,
    bold: captions.bold,
    fillColor: captions.textColor,
    highlightColor: captions.highlightColor,
    stroke: { enabled: captions.outlinePx > 0, color: captions.outlineColor, widthPx: captions.outlinePx > 0 ? captions.outlinePx : DEFAULT_CAPTION_STROKE_WIDTH_PX },
    position: captions.placement ? { anchor: captions.placement.anchor, percent: captions.placement.marginPct } : { anchor: "bottom", percent: CAPTION_SAFE_ZONE.bottom * 100 },
    maxLines: captions.maxLines <= 1 ? 1 : 2,
    animation: captions.highlight === "word" ? "word_highlight" : "none",
    colorCycle: captions.colorCycle?.length ? [...captions.colorCycle] : null,
  };
}

const safeHex = (value: string | null | undefined, fallback: string): string => normalizeHexColor(value) ?? fallback;

/** The ASS style of a resolved caption style (LyOnix render AND the Studio preview lay captions out with exactly this). */
export function captionAssStyle(style: CaptionTextStyle): Required<CaptionCueStyle> {
  const fill = safeHex(style.fillColor, "#FFFFFF");
  return {
    fontName: style.font.family,
    fontSizePx: style.fontSizePx,
    minFontSizePx: style.minFontSizePx,
    maxLines: style.maxLines,
    bold: style.bold,
    textColor: fill,
    highlightColor: safeHex(style.highlightColor, fill),
    outlineColor: safeHex(style.stroke.color, "#000000"),
    outlinePx: style.stroke.enabled ? style.stroke.widthPx : 0,
    highlight: style.animation === "word_highlight" ? "word" : "none",
    verticalAnchor: style.position.anchor === "top" ? "top" : style.position.anchor === "center" ? "middle" : "bottom",
    marginVPercent: style.position.percent,
  };
}

/**
 * Options for laying a caption out with `buildCaptionAss` the way the engine does: LyOnix exactly (same style as the render); Creatomate
 * approximately (fixed size, pages of <= maxLines at the default box width - the Creatomate Preview SDK is the exact view).
 */
export function captionLayoutOptions(style: CaptionTextStyle, engine: CaptionStyleEngine, canvas = { width: 1080, height: 1920 }): CaptionStyleOptions {
  if (engine === "creatomate") {
    return {
      canvas,
      fontName: style.font.family,
      fontSizePx: style.fontSizePx,
      minFontSizePx: style.fontSizePx,
      maxLines: style.maxLines,
      bold: style.bold,
      highlight: "none",
      widthSafety: CREATOMATE_CAPTION_WIDTH_SAFETY,
      placement: { x: canvas.width / 2, y: canvas.height / 2, widthPx: CREATOMATE_DEFAULT_CAPTION_WIDTH_FRACTION * canvas.width },
    };
  }
  return { canvas, ...captionAssStyle(style) };
}
