/**
 * VE2E-93: the caption fonts Studio may offer. A font is listed only when the browser preview AND every render engine draw it with the
 * same typeface, each under its own registered name (fontconfig family on the LyOnix media-worker, Google Fonts family on Creatomate,
 * CSS family in the browser). Adding a font means installing it in the media-worker image, loading it in `apps/web/index.html` and
 * checking the Creatomate name - never just appending a row here. Pure, browser-safe (subpath `@lyonix/domain/caption-fonts`).
 */

export type CaptionFontScript = "latin" | "ja" | "ko" | "vi";

export type CaptionFontEntry = {
  /** Stable id stored in timelines (`dynamicStyle.captionFontId`, scene `captionStyleOverride.fontId`). */
  id: string;
  /** Display name (a font name, not translated). */
  label: string;
  /** Family name per engine. */
  families: { lyonix: string; creatomate: string };
  /** CSS `font-family` list used by the browser preview. */
  css: string;
  /** Scripts verified to render with this font on the preview and on every engine. */
  verifiedScripts: readonly CaptionFontScript[];
};

export const CAPTION_FONTS: readonly CaptionFontEntry[] = [
  {
    id: "noto-sans-jp",
    label: "Noto Sans JP",
    // Debian `fonts-noto-cjk` (media-worker image) registers the Pan-CJK face as "Noto Sans CJK JP"; Google Fonts (Creatomate, browser)
    // ships the same Source Han Sans design as "Noto Sans JP".
    families: { lyonix: "Noto Sans CJK JP", creatomate: "Noto Sans JP" },
    css: '"Noto Sans JP", "Noto Sans CJK JP", sans-serif',
    verifiedScripts: ["latin", "ja"],
  },
];

const BY_ID = new Map(CAPTION_FONTS.map((font) => [font.id, font]));

export const captionFontById = (id: string | null | undefined): CaptionFontEntry | null => (id ? BY_ID.get(id) ?? null : null);

/** Catalog entry whose name on any engine (or label) is `family`, case-insensitive; null for a font outside the catalog. */
export function captionFontByFamily(family: string | null | undefined): CaptionFontEntry | null {
  const wanted = family?.trim().toLowerCase();
  if (!wanted) return null;
  return CAPTION_FONTS.find((font) => [font.label, font.families.lyonix, font.families.creatomate].some((name) => name.toLowerCase() === wanted)) ?? null;
}

/** CSS `font-family` for a family outside the catalog (template default or legacy value): the family itself, then the generic face. */
export const cssFontStackForFamily = (family: string): string => `"${family.replace(/["\\;{}]/g, "")}", sans-serif`;

const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const JAPANESE_RE = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;
// Letters other Latin languages rarely use (breve a, stroked d, horn o/u) plus the Latin Extended Additional block of stacked tone marks.
const VIETNAMESE_RE = /[ăđơưĂĐƠƯẠ-ỹ]/;
const LATIN_RE = /[A-Za-z]/;

/** Scripts present in a caption text (used to warn when a font is not verified for them). */
export function detectCaptionScripts(text: string): Set<CaptionFontScript> {
  const scripts = new Set<CaptionFontScript>();
  if (LATIN_RE.test(text)) scripts.add("latin");
  if (JAPANESE_RE.test(text)) scripts.add("ja");
  if (HANGUL_RE.test(text)) scripts.add("ko");
  if (VIETNAMESE_RE.test(text)) scripts.add("vi");
  return scripts;
}

/** Scripts of `texts` that `font` is not verified for (empty = fine). */
export function unverifiedCaptionScripts(font: CaptionFontEntry, texts: readonly string[]): CaptionFontScript[] {
  const found = new Set<CaptionFontScript>();
  for (const text of texts) for (const script of detectCaptionScripts(text)) found.add(script);
  return [...found].filter((script) => !font.verifiedScripts.includes(script));
}
