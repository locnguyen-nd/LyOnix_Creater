import { describe, expect, it } from "vitest";
import {
  applyDynamicStyleOverrides,
  buildDynamicComposition,
  DEFAULT_DYNAMIC_SCENE_STYLE,
  DYNAMIC_STYLE_OPTION_KEYS,
  extractDynamicStyleFromTemplate,
  isDynamicStyleOptionKey,
  isValidDynamicStyleOptionValue,
} from "./creatomate-dynamic.js";

describe("extractDynamicStyleFromTemplate", () => {
  it("lifts text and image style from the first matching element, ignoring transcript-driven fields", () => {
    const raw = [
      {
        type: "composition",
        elements: [
          { type: "image", color_overlay: "rgba(0,0,0,0.3)", animations: [{ type: "pan", start_x: "40%", end_x: "60%", start_scale: "110%", end_scale: "100%", easing: "ease-out" }] },
          {
            type: "text",
            font_family: "Poppins",
            font_size: "10 vmin",
            fill_color: "#eeeeee",
            transcript_source: "some-audio-id",
            transcript_effect: "highlight",
          },
        ],
      },
    ];
    const style = extractDynamicStyleFromTemplate(raw);
    expect(style.text.fontFamily).toBe("Poppins");
    expect(style.text.fontSize).toBe("10 vmin");
    expect(style.text.fillColor).toBe("#eeeeee");
    expect(style.image.colorOverlay).toBe("rgba(0,0,0,0.3)");
    expect(style.image.animation).toMatchObject({ type: "pan", startX: "40%", endX: "60%" });
    expect(style).not.toHaveProperty("text.transcript_source");
  });

  it("falls back to defaults when no template is pinned", () => {
    expect(extractDynamicStyleFromTemplate(null)).toEqual(DEFAULT_DYNAMIC_SCENE_STYLE);
  });

  it("VE2E-26: rejects an animation entry whose type lacks pan/zoom scale/position fields, falling back to the safe default instead of a broken hybrid object", () => {
    const raw = [
      {
        type: "composition",
        elements: [
          // The template's own first animation entry is a fade (no start_scale/end_scale/
          // start_x/end_x at all) - accepting it blindly would previously produce
          // `{ type: "fade", start_scale: <default>, ... }`, a shape Creatomate never authored.
          { type: "image", animations: [{ type: "fade", easing: "ease-in" }] },
        ],
      },
    ];
    const style = extractDynamicStyleFromTemplate(raw);
    expect(style.image.animation).toEqual(DEFAULT_DYNAMIC_SCENE_STYLE.image.animation);
  });

  it("VE2E-26: accepts a real pan/zoom entry that appears after a non-matching one in the same animations array", () => {
    const raw = [
      {
        type: "composition",
        elements: [
          {
            type: "video",
            animations: [
              { type: "fade", easing: "ease-in" },
              { type: "pan", start_x: "10%", end_x: "90%", start_scale: "100%", end_scale: "130%", easing: "linear" },
            ],
          },
        ],
      },
    ];
    const style = extractDynamicStyleFromTemplate(raw);
    expect(style.image.animation).toMatchObject({ type: "pan", startX: "10%", endX: "90%" });
  });

  it("VE2E-26: prefers a conventionally-named Subtitles/Image element over an earlier unnamed/unrelated node of the same type", () => {
    const raw = [
      {
        type: "composition",
        elements: [
          // A decorative/logo text node appears first in the tree but is not the real caption.
          { type: "text", name: "Watermark-1", font_family: "Wrong Font", fill_color: "#111111" },
          { type: "text", name: "Subtitles-1", font_family: "Poppins", fill_color: "#eeeeee" },
          { type: "image", name: "Logo-1", color_overlay: "rgba(9,9,9,0.9)" },
          { type: "image", name: "News-Image", color_overlay: "rgba(0,0,0,0.3)" },
        ],
      },
    ];
    const style = extractDynamicStyleFromTemplate(raw);
    expect(style.text.fontFamily).toBe("Poppins");
    expect(style.text.fillColor).toBe("#eeeeee");
    expect(style.image.colorOverlay).toBe("rgba(0,0,0,0.3)");
  });
});

describe("dynamic style overrides (VE2E-26)", () => {
  it("isValidDynamicStyleOptionValue accepts well-formed values and rejects malformed ones", () => {
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily, "Inter Bold")).toBe(true);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily, "Inter; DROP TABLE")).toBe(false);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFillColor, "#ffffff")).toBe(true);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFillColor, "not-a-color")).toBe(false);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.imageAnimation, "pan")).toBe(true);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.imageAnimation, "none")).toBe(true);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.imageAnimation, "spin")).toBe(false);
    expect(isValidDynamicStyleOptionValue("dynamicStyle.unknown", "x")).toBe(false);
  });

  it("isValidDynamicStyleOptionValue treats an empty string as the valid 'use template default' choice, for any known key", () => {
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily, "")).toBe(true);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.captionFillColor, "")).toBe(true);
    expect(isValidDynamicStyleOptionValue(DYNAMIC_STYLE_OPTION_KEYS.imageAnimation, "")).toBe(true);
    expect(isValidDynamicStyleOptionValue("dynamicStyle.unknown", "")).toBe(false);
  });

  it("isDynamicStyleOptionKey recognizes exactly the whitelisted keys, never a real modification key", () => {
    expect(isDynamicStyleOptionKey(DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily)).toBe(true);
    expect(isDynamicStyleOptionKey("Text-1.text")).toBe(false);
  });

  it("applies a valid override on top of the base style, preserving every field the user did not override", () => {
    const overridden = applyDynamicStyleOverrides(DEFAULT_DYNAMIC_SCENE_STYLE, {
      [DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily]: "Noto Sans",
    });
    expect(overridden.text.fontFamily).toBe("Noto Sans");
    expect(overridden.text.fontSize).toBe(DEFAULT_DYNAMIC_SCENE_STYLE.text.fontSize);
    expect(overridden.text.fillColor).toBe(DEFAULT_DYNAMIC_SCENE_STYLE.text.fillColor);
    expect(overridden.image).toEqual(DEFAULT_DYNAMIC_SCENE_STYLE.image);
  });

  it("ignores an invalid stored override value instead of applying it (defense in depth)", () => {
    const overridden = applyDynamicStyleOverrides(DEFAULT_DYNAMIC_SCENE_STYLE, {
      [DYNAMIC_STYLE_OPTION_KEYS.captionFillColor]: "javascript:alert(1)",
    });
    expect(overridden.text.fillColor).toBe(DEFAULT_DYNAMIC_SCENE_STYLE.text.fillColor);
  });

  it("imageAnimation:'none' explicitly suppresses the pan/zoom animation", () => {
    const overridden = applyDynamicStyleOverrides(DEFAULT_DYNAMIC_SCENE_STYLE, { [DYNAMIC_STYLE_OPTION_KEYS.imageAnimation]: "none" });
    expect(overridden.image.animation).toBeUndefined();
  });

  it("imageAnimation:'pan' (or unset) keeps the base animation untouched", () => {
    const overridden = applyDynamicStyleOverrides(DEFAULT_DYNAMIC_SCENE_STYLE, { [DYNAMIC_STYLE_OPTION_KEYS.imageAnimation]: "pan" });
    expect(overridden.image.animation).toEqual(DEFAULT_DYNAMIC_SCENE_STYLE.image.animation);
  });
});

describe("buildDynamicComposition", () => {
  it("stacks scenes sequentially with time offsets derived from each scene's own audio duration", () => {
    const scenes = [
      { sceneId: "s1", mediaUrl: "https://x/img1", mediaKind: "image" as const, text: "Hook", audioUrl: "https://x/a1", audioDurationMs: 3000 },
      { sceneId: "s2", mediaUrl: "https://x/vid2", mediaKind: "video" as const, text: "Body", audioUrl: "https://x/a2", audioDurationMs: 5000 },
    ];
    const source = buildDynamicComposition(scenes, DEFAULT_DYNAMIC_SCENE_STYLE, { width: 1080, height: 1920 });
    expect(source.width).toBe(1080);
    expect(source.height).toBe(1920);
    const elements = source.elements as Array<{ time: number; duration: number; elements: Array<{ type: string; source?: string; text?: string }> }>;
    expect(elements).toHaveLength(2);
    expect(elements[0]!.time).toBe(0);
    expect(elements[0]!.duration).toBe(3);
    expect(elements[1]!.time).toBe(3);
    expect(elements[1]!.duration).toBe(5);
    expect(elements[0]!.elements[0]).toMatchObject({ type: "image", source: "https://x/img1" });
    expect(elements[1]!.elements[0]).toMatchObject({ type: "video", source: "https://x/vid2" });
    expect(elements[0]!.elements[1]).toMatchObject({ type: "text", text: "Hook" });
    expect(elements[0]!.elements[2]).toMatchObject({ type: "audio", source: "https://x/a1" });
  });

  it("VE2E-41: previews the selected source range from the original video", () => {
    const source = buildDynamicComposition([{
      sceneId: "s1", mediaUrl: "https://x/original.mp4", mediaKind: "video", text: "Caption",
      audioUrl: "https://x/a1", audioDurationMs: 3000, sourceStartMs: 4200, sourceDurationMs: 3000,
    }], DEFAULT_DYNAMIC_SCENE_STYLE, { width: 1080, height: 1920 });
    const elements = source.elements as Array<{ elements: Array<Record<string, unknown>> }>;
    expect(elements[0]!.elements[0]).toMatchObject({ source: "https://x/original.mp4", trim_start: 4.2, trim_duration: 3 });
  });

  it("does not add video trim fields when the scene has no source range", () => {
    const source = buildDynamicComposition([{
      sceneId: "s1", mediaUrl: "https://x/original.mp4", mediaKind: "video", text: "Caption",
      audioUrl: "https://x/a1", audioDurationMs: 3000,
    }], DEFAULT_DYNAMIC_SCENE_STYLE, { width: 1080, height: 1920 });
    const elements = source.elements as Array<{ elements: Array<Record<string, unknown>> }>;
    expect(elements[0]!.elements[0]).not.toHaveProperty("trim_start");
    expect(elements[0]!.elements[0]).not.toHaveProperty("trim_duration");
  });

  it("VE2E-32: builds one timed text node per real caption segment instead of one static block for the whole scene", () => {
    const scenes = [
      {
        sceneId: "s1",
        mediaUrl: "https://x/img1",
        mediaKind: "image" as const,
        text: "fallback static text",
        captionSegments: [
          { text: "Messi is a football player.", startMs: 0, endMs: 1800 },
          { text: "He plays for Inter Miami now.", startMs: 1800, endMs: 3600 },
        ],
        audioUrl: "https://x/a1",
        audioDurationMs: 4000,
      },
    ];
    const source = buildDynamicComposition(scenes, DEFAULT_DYNAMIC_SCENE_STYLE, { width: 1080, height: 1920 });
    const elements = source.elements as Array<{ elements: Array<{ type: string; time?: number; duration?: number; text?: string }> }>;
    const textNodes = elements[0]!.elements.filter((el) => el.type === "text");
    expect(textNodes).toHaveLength(2);
    expect(textNodes[0]).toMatchObject({ text: "Messi is a football player.", time: 0, duration: 1.8 });
    expect(textNodes[1]).toMatchObject({ text: "He plays for Inter Miami now.", time: 1.8, duration: 1.8 });
    // audio is still the last element, after every caption node.
    expect(elements[0]!.elements.at(-1)).toMatchObject({ type: "audio" });
  });

  it("VE2E-32: falls back to one static text block for the whole scene when captionSegments is omitted", () => {
    const scenes = [{ sceneId: "s1", mediaUrl: "https://x/img1", mediaKind: "image" as const, text: "Hook", audioUrl: "https://x/a1", audioDurationMs: 2000 }];
    const source = buildDynamicComposition(scenes, DEFAULT_DYNAMIC_SCENE_STYLE, { width: 1080, height: 1920 });
    const elements = source.elements as Array<{ elements: Array<{ type: string; time?: number; duration?: number; text?: string }> }>;
    const textNodes = elements[0]!.elements.filter((el) => el.type === "text");
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0]).toMatchObject({ type: "text", time: 0, duration: 2, text: "Hook" });
  });

  it("never fabricates a Creatomate-native voiceover/transcript element - audio and text stay plain", () => {
    const scenes = [{ sceneId: "s1", mediaUrl: "https://x/img1", mediaKind: "image" as const, text: "Hook", audioUrl: "https://x/a1", audioDurationMs: 1000 }];
    const source = buildDynamicComposition(scenes, DEFAULT_DYNAMIC_SCENE_STYLE, { width: 1080, height: 1920 });
    const elements = source.elements as Array<{ elements: Array<Record<string, unknown>> }>;
    expect(elements[0]!.elements[2]).not.toHaveProperty("provider");
    expect(elements[0]!.elements[1]).not.toHaveProperty("transcript_source");
  });
});
