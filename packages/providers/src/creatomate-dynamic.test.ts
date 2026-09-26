import { describe, expect, it } from "vitest";
import { buildDynamicComposition, DEFAULT_DYNAMIC_SCENE_STYLE, extractDynamicStyleFromTemplate } from "./creatomate-dynamic.js";

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

  it("never fabricates a Creatomate-native voiceover/transcript element - audio and text stay plain", () => {
    const scenes = [{ sceneId: "s1", mediaUrl: "https://x/img1", mediaKind: "image" as const, text: "Hook", audioUrl: "https://x/a1", audioDurationMs: 1000 }];
    const source = buildDynamicComposition(scenes, DEFAULT_DYNAMIC_SCENE_STYLE, { width: 1080, height: 1920 });
    const elements = source.elements as Array<{ elements: Array<Record<string, unknown>> }>;
    expect(elements[0]!.elements[2]).not.toHaveProperty("provider");
    expect(elements[0]!.elements[1]).not.toHaveProperty("transcript_source");
  });
});
