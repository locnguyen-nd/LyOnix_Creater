import { describe, expect, it } from "vitest";
import {
  CAPTION_PRESETS,
  captionCapabilitiesForStyle,
  captionPresetById,
  captionPresetChanges,
  captionPresetOptionValues,
  captionPresetSupport,
} from "./caption-presets.js";
import { CAPTION_STYLE_ENGINES } from "./caption-style-capabilities.js";
import {
  CAPTION_PATCH_FIELDS,
  CAPTION_PRESET_OPTION_KEY,
  captionPresetIdFromOptionValues,
  captionStyleFromOptionValues,
  clearCaptionStyleOptionValues,
  isCaptionStyleOptionKey,
  isValidCaptionStyleOptionValue,
  normalizeCaptionTextStylePatch,
  resolveCaptionTextStyle,
  validateCaptionTextStylePatch,
} from "./caption-style.js";
import { pickCreationPreferences, resolveInitialForm, sanitizeJobNewDraft, SYSTEM_CREATION_DEFAULTS } from "./creation-form.js";

describe("VE2E-94 caption preset catalog", () => {
  it("(1, 2) has 6 presets with unique, well-formed ids and translation keys", () => {
    expect(CAPTION_PRESETS.map((item) => item.id)).toEqual(["clean-white", "news-bold", "sports-punch", "karaoke-highlight", "minimal", "breaking-red"]);
    expect(new Set(CAPTION_PRESETS.map((item) => item.id)).size).toBe(CAPTION_PRESETS.length);
    for (const item of CAPTION_PRESETS) {
      expect(item.id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
      expect(item.version).toBeGreaterThanOrEqual(1);
      expect(item.nameKey).toBe(`captionPresets.items.${item.id}.name`);
      expect(item.descriptionKey).toBe(`captionPresets.items.${item.id}.description`);
      expect(captionPresetById(item.id)).toBe(item);
    }
    expect(captionPresetById("nope")).toBeNull();
  });

  it("(3) every preset sets every VE2E-93 field, each with a value the renderers accept (max 2 lines)", () => {
    for (const item of CAPTION_PRESETS) {
      expect(Object.keys(item.style).sort(), item.id).toEqual([...CAPTION_PATCH_FIELDS].sort());
      expect(validateCaptionTextStylePatch(item.style), item.id).toEqual({ ok: true, value: item.style });
      expect(normalizeCaptionTextStylePatch(item.style)).toEqual(item.style);
      expect([1, 2]).toContain(item.style.maxLines);
    }
  });

  it("(4) declares exactly the capabilities its style needs", () => {
    for (const item of CAPTION_PRESETS) expect([...item.requiredCapabilities].sort(), item.id).toEqual(captionCapabilitiesForStyle(item.style).sort());
    expect(captionPresetById("karaoke-highlight")!.requiredCapabilities).toContain("wordHighlight");
    expect(CAPTION_PRESETS.filter((item) => item.requiredCapabilities.includes("wordHighlight")).map((item) => item.id)).toEqual(["karaoke-highlight"]);
  });

  it("(12-15) support comes from the capability map: LyOnix all, Creatomate no karaoke, Orshot none", () => {
    expect(CAPTION_STYLE_ENGINES).toEqual(["lyonix", "creatomate", "orshot"]);
    for (const item of CAPTION_PRESETS) {
      expect(captionPresetSupport("lyonix", item), item.id).toEqual({ ok: true });
      expect(captionPresetSupport("orshot", item), item.id).toEqual({ ok: false, reason: "provider_unsupported" });
      expect(captionPresetSupport("creatomate", item), item.id).toEqual(item.id === "karaoke-highlight" ? { ok: false, reason: "no_word_highlight" } : { ok: true });
    }
  });

  it("(7) a preset's change set covers every field; its option values are the resolved values plus the id", () => {
    const item = captionPresetById("sports-punch")!;
    expect(captionPresetChanges(item).map((change) => change.field)).toEqual([...CAPTION_PATCH_FIELDS]);
    const values = captionPresetOptionValues(item);
    expect(values).toMatchObject({ "dynamicStyle.captionFontSizePx": "96", "dynamicStyle.captionPosition": "middle", "dynamicStyle.captionMaxLines": "1", [CAPTION_PRESET_OPTION_KEY]: "sports-punch" });
    for (const [key, value] of Object.entries(values)) expect(isValidCaptionStyleOptionValue(key, value), key).toBe(true);
    expect(captionStyleFromOptionValues(values).patch).toEqual(item.style);
  });

  it("(11) a stored video keeps its look whatever the catalog becomes: renderers read the values, never the preset id", () => {
    const stored = captionPresetOptionValues(captionPresetById("breaking-red")!);
    const style = resolveCaptionTextStyle({ engine: "lyonix", global: captionStyleFromOptionValues(stored).patch });
    // the preset renamed / removed / its values changed later: the stored values still resolve to the same style
    const renamed = { ...stored, [CAPTION_PRESET_OPTION_KEY]: "breaking-red-v2" };
    expect(resolveCaptionTextStyle({ engine: "lyonix", global: captionStyleFromOptionValues(renamed).patch })).toEqual(style);
    expect(style).toMatchObject({ fontSizePx: 80, fillColor: "#FFFFFF", stroke: { enabled: true, color: "#E00000", widthPx: 10 }, position: { preset: "top" } });
  });

  it("(23) the preset id key is UI metadata: validated by format, ignored by the style, cleared by a whole-video reset", () => {
    expect(isCaptionStyleOptionKey(CAPTION_PRESET_OPTION_KEY)).toBe(true);
    expect(isValidCaptionStyleOptionValue(CAPTION_PRESET_OPTION_KEY, "removed-preset")).toBe(true); // a preset later removed never blocks a save
    expect(isValidCaptionStyleOptionValue(CAPTION_PRESET_OPTION_KEY, "Bad Id!")).toBe(false);
    expect(captionPresetIdFromOptionValues({ [CAPTION_PRESET_OPTION_KEY]: "news-bold" })).toBe("news-bold");
    expect(captionPresetIdFromOptionValues({})).toBeNull();
    expect(captionStyleFromOptionValues({ [CAPTION_PRESET_OPTION_KEY]: "news-bold" }).patch).toEqual({});
    expect(clearCaptionStyleOptionValues({ [CAPTION_PRESET_OPTION_KEY]: "news-bold", other: "1" })).toEqual({ other: "1" });
  });
});

describe("VE2E-94 caption preset in the create-video draft / defaults (17, 18)", () => {
  it("is a draft value and a user default; an unknown id is dropped, everything else kept", () => {
    expect(SYSTEM_CREATION_DEFAULTS.captionPresetId).toBe("");
    expect(sanitizeJobNewDraft({ topic: "x", captionPresetId: "news-bold" })).toEqual({ topic: "x", captionPresetId: "news-bold" });
    expect(sanitizeJobNewDraft({ topic: "x", captionPresetId: "gone" })).toEqual({ topic: "x" });
    expect(pickCreationPreferences({ ...SYSTEM_CREATION_DEFAULTS, captionPresetId: "minimal", topic: "secret" })).toMatchObject({ captionPresetId: "minimal" });
    expect(pickCreationPreferences({ ...SYSTEM_CREATION_DEFAULTS, captionPresetId: "minimal", topic: "secret" })).not.toHaveProperty("topic");
    const form = resolveInitialForm({ preferences: { captionPresetId: "minimal", language: "ja" }, draft: { captionPresetId: "sports-punch" } });
    expect(form.values).toMatchObject({ captionPresetId: "sports-punch", language: "ja" });
    expect(form.sources.captionPresetId).toBe("draft");
    // drafts/defaults saved before VE2E-94 have no preset: the template's own style
    expect(resolveInitialForm({ preferences: { language: "ko" }, draft: { topic: "t" } }).values.captionPresetId).toBe("");
  });
});
