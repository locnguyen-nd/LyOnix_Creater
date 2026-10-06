/**
 * VE2E-93: the ONE place that says which caption style controls each render engine really applies. Studio derives every control's
 * enabled/disabled state (and the reason shown to the user) from this map; nothing else hard-codes engine support. A field is listed
 * as supported only when the final render applies it (see docs: .docs/specs/VE2E-93.md §4.4/4.5). Pure, browser-safe.
 */

export const CAPTION_STYLE_ENGINES = ["lyonix", "creatomate", "orshot"] as const;
export type CaptionStyleEngine = (typeof CAPTION_STYLE_ENGINES)[number];

export const CAPTION_STYLE_FIELDS = ["font", "fontSize", "fillColor", "stroke", "position", "maxLines", "animation"] as const;
export type CaptionStyleField = (typeof CAPTION_STYLE_FIELDS)[number];

export const CAPTION_ANIMATIONS = ["none", "word_highlight"] as const;
export type CaptionAnimation = (typeof CAPTION_ANIMATIONS)[number];

/** Why a control is disabled; each reason has a translated message in Studio (`studioPro.textStyleReason.<reason>`). */
export type CaptionStyleUnsupportedReason = "provider_unsupported" | "no_word_highlight";

export type CaptionStyleCapability = {
  /** False = the whole panel is read-only for this engine. */
  editable: boolean;
  /** Per-scene overrides are applied by the final render. */
  sceneOverride: boolean;
  fields: Readonly<Record<CaptionStyleField, boolean>>;
  /** Animation values the final render really draws (always includes "none"). */
  animations: readonly CaptionAnimation[];
  /** Reason per unsupported field (`all` when the whole panel is read-only). */
  reasons: Readonly<Partial<Record<CaptionStyleField | "all", CaptionStyleUnsupportedReason>>>;
};

const ALL_FIELDS = (value: boolean): Record<CaptionStyleField, boolean> =>
  Object.fromEntries(CAPTION_STYLE_FIELDS.map((field) => [field, value])) as Record<CaptionStyleField, boolean>;

export const CAPTION_STYLE_CAPABILITIES: Readonly<Record<CaptionStyleEngine, CaptionStyleCapability>> = {
  // Burned-in ASS (packages/domain/src/caption-ass.ts): font, size (shrink ladder), colours, outline, top/middle/bottom anchor,
  // 1..2 lines and the per-word karaoke highlight; one ASS style per distinct scene style.
  lyonix: { editable: true, sceneOverride: true, fields: ALL_FIELDS(true), animations: ["none", "word_highlight"], reasons: {} },
  // Dynamic composition text elements: font_family/font_size/fill_color/stroke/y + anchors, pages of <= maxLines. The pipeline strips
  // Creatomate's transcript (karaoke) properties on purpose, so there is no per-word highlight.
  creatomate: {
    editable: true,
    sceneOverride: true,
    fields: { ...ALL_FIELDS(true), animation: false },
    animations: ["none"],
    reasons: { animation: "no_word_highlight" },
  },
  // Orshot renders a fixed-slot template: no caption style is sent at all.
  orshot: { editable: false, sceneOverride: false, fields: ALL_FIELDS(false), animations: ["none"], reasons: { all: "provider_unsupported" } },
};

export const captionStyleCapability = (engine: CaptionStyleEngine): CaptionStyleCapability => CAPTION_STYLE_CAPABILITIES[engine];

/** Reason a field is disabled for `engine`, or null when it is editable. */
export function captionStyleFieldReason(engine: CaptionStyleEngine, field: CaptionStyleField): CaptionStyleUnsupportedReason | null {
  const capability = CAPTION_STYLE_CAPABILITIES[engine];
  if (!capability.editable) return capability.reasons.all ?? "provider_unsupported";
  return capability.fields[field] ? null : capability.reasons[field] ?? "provider_unsupported";
}

/**
 * The engine whose capabilities apply in Studio: Orshot when the selected render account or the pinned template is Orshot, else the
 * pinned template's engine (snapshots captured before VE2E-108 carry no engine and are Creatomate). Null = no template pinned yet.
 */
export function captionStyleEngineFor(input: { templateEngine: string | null | undefined; hasTemplate: boolean; renderProvider?: string | null | undefined }): CaptionStyleEngine | null {
  if (!input.hasTemplate) return null;
  if (input.renderProvider === "orshot" || input.templateEngine === "orshot") return "orshot";
  return input.templateEngine === "lyonix" ? "lyonix" : "creatomate";
}
