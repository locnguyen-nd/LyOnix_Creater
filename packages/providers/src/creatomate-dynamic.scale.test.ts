import { describe, expect, it } from "vitest";
import {
  applyDynamicStyleOverrides,
  buildDynamicComposition,
  buildDynamicCompositionWithWarnings,
  countTemplateSceneSlots,
  DYNAMIC_STYLE_OPTION_KEYS,
  extractDynamicStyleFromTemplate,
  type DynamicSceneInput,
} from "./creatomate-dynamic.js";
import { newsRecapJpTemplate, top5CountdownTemplate } from "./fixtures/creatomate-templates.js";

type Node = Record<string, any>;

const makeScenes = (count: number): DynamicSceneInput[] =>
  Array.from({ length: count }, (_, index) => ({
    sceneId: `s${index + 1}`,
    mediaUrl: `https://lyonix.test/media/${index + 1}`,
    mediaKind: index % 3 === 2 ? "image" : "video",
    text: `ナレーション ${index + 1}`,
    audioUrl: `https://lyonix.test/audio/${index + 1}`,
    audioDurationMs: 4000 + index * 100,
  }));

const build = (raw: unknown, count: number, scenes = makeScenes(count), optionValues: Record<string, string> = {}) => {
  const style = applyDynamicStyleOverrides(extractDynamicStyleFromTemplate(raw), optionValues);
  return buildDynamicCompositionWithWarnings(scenes, style, { width: 1080, height: 1920 });
};

const sceneNodes = (source: Record<string, unknown>): Node[] => (source.elements as Node[]).filter((el) => el.type === "composition");
const childrenOf = (scene: Node, type: string): Node[] => (scene.elements as Node[]).filter((el) => el.type === type);

describe("VE2E-52 template slot detection", () => {
  it("counts Scene compositions of the two real templates", () => {
    expect(countTemplateSceneSlots(newsRecapJpTemplate())).toBe(10);
    expect(countTemplateSceneSlots(top5CountdownTemplate())).toBe(5);
  });

  it("has no scene slots for a flat template and reports the generic fallback with a warning", () => {
    const flat = { width: 1080, height: 1920, elements: [{ type: "image", name: "Image-1", dynamic: true }, { type: "text", name: "Text-1", dynamic: true }] };
    expect(countTemplateSceneSlots(flat)).toBe(0);
    const result = build(flat, 3);
    expect(result.warnings).toEqual(["template_layout_fallback"]);
    expect(sceneNodes(result.source)).toHaveLength(3);
  });
});

describe.each([3, 10, 25])("VE2E-52 News Recap JP template scaled to %i scenes", (count) => {
  const scenes = makeScenes(count);
  const { source, warnings } = build(newsRecapJpTemplate(), count, scenes);
  const composed = sceneNodes(source);

  it("emits exactly N scenes, none dropped, with the template's root props and Badge kept once", () => {
    expect(composed).toHaveLength(count);
    expect(composed.map((scene) => scene.name)).toEqual(Array.from({ length: count }, (_, i) => `Scene-${i + 1}`));
    expect(source).toMatchObject({ width: 1080, height: 1920, fill_color: "#000000", frame_rate: 30, output_format: "mp4" });
    expect(source).not.toHaveProperty("duration");
    const badges = (source.elements as Node[]).filter((el) => el.name === "Badge-BreakingNews");
    expect(badges).toHaveLength(1);
    // The badge spanned the whole 80 s template; it must now span the whole re-sized video.
    expect(badges[0]).not.toHaveProperty("duration");
    expect(warnings).toEqual([]);
  });

  it("names elements Video-i/Subtitles-i/Voiceover-i and inherits the prototype layout", () => {
    composed.forEach((scene, index) => {
      const n = index + 1;
      const names = (scene.elements as Node[]).map((el) => el.name);
      expect(names).toEqual([`Video-${n}`, `Subtitles-${n}`, `Voiceover-${n}`]);
      const [visual] = scene.elements as Node[];
      expect(visual).toMatchObject({ type: scenes[index]!.mediaKind, source: scenes[index]!.mediaUrl, width: "100%", height: "44%", fit: "cover", time: 0 });
      const subtitle = childrenOf(scene, "text")[0]!;
      expect(subtitle).toMatchObject({ y: "6%", width: "88%", font_family: "Noto Sans JP", font_weight: "900", text: scenes[index]!.text });
      expect(scene.fill_color).toBe("#0b0b0b");
    });
  });

  it("cycles the template's alternating subtitle colors", () => {
    composed.forEach((scene, index) => {
      expect(childrenOf(scene, "text")[0]!.fill_color).toBe(index % 2 === 0 ? "#ffffff" : "#ffe600");
    });
  });

  it("uses each scene's real voice duration, back to back with no gaps", () => {
    let cursor = 0;
    composed.forEach((scene, index) => {
      const seconds = scenes[index]!.audioDurationMs / 1000;
      expect(scene.duration).toBeCloseTo(seconds, 6);
      expect(scene.time).toBeCloseTo(cursor, 6);
      cursor += seconds;
      const audio = childrenOf(scene, "audio")[0]!;
      expect(audio.duration).toBeCloseTo(seconds, 6);
      expect(childrenOf(scene, "text")[0]!.duration).toBeCloseTo(seconds, 6);
    });
  });

  it("points audio at the LyOnix file, removes the template TTS provider and every dynamic/transcript flag", () => {
    composed.forEach((scene, index) => {
      const audio = childrenOf(scene, "audio")[0]!;
      expect(audio.source).toBe(scenes[index]!.audioUrl);
      expect(audio).not.toHaveProperty("provider");
    });
    const json = JSON.stringify(source);
    expect(json).not.toContain("elevenlabs");
    expect(json).not.toContain('"provider"');
    expect(json).not.toContain('"dynamic"');
    expect(json).not.toContain("transcript_");
  });
});

describe.each([3, 10, 25])("VE2E-52 Top 5 Countdown template scaled to %i scenes", (count) => {
  const scenes = makeScenes(count);
  const { source, warnings } = build(top5CountdownTemplate(), count, scenes);
  const composed = sceneNodes(source);

  it("emits N scenes with every prototype element and the root Logo-Top5", () => {
    expect(composed).toHaveLength(count);
    composed.forEach((scene, index) => {
      const n = index + 1;
      expect((scene.elements as Node[]).map((el) => el.name)).toEqual([`Video-${n}`, `Shade-${n}`, `RankBadge-${n}`, `Subtitles-${n}`, `Voiceover-${n}`]);
    });
    expect((source.elements as Node[]).filter((el) => el.name === "Logo-Top5")).toHaveLength(1);
  });

  it("renumbers the countdown rank badges N..1 (rule for non-interchangeable scenes) and says so", () => {
    const badges = composed.map((scene) => (scene.elements as Node[]).find((el) => String(el.name).startsWith("RankBadge"))!.text);
    expect(badges).toEqual(Array.from({ length: count }, (_, i) => `第${count - i}位`));
    expect(warnings).toContain("rank_badges_renumbered");
  });

  it("cycles the template's own transitions and keeps the audio-driven durations and no TTS provider", () => {
    composed.forEach((scene, index) => {
      const expected = [undefined, "wipe", "circular-wipe", "flip", "slide"][index % 5];
      const transition = (scene.animations as Node[] | undefined)?.[0]?.type;
      expect(transition).toBe(expected);
      expect(scene.duration).toBeCloseTo(scenes[index]!.audioDurationMs / 1000, 6);
      const audio = childrenOf(scene, "audio")[0]!;
      expect(audio).not.toHaveProperty("provider");
      expect(audio.source).toBe(scenes[index]!.audioUrl);
      const shade = (scene.elements as Node[]).find((el) => el.type === "shape")!;
      expect(shade).not.toHaveProperty("duration");
    });
    expect(JSON.stringify(source)).not.toContain("elevenlabs");
  });
});

describe("VE2E-52 generator details", () => {
  it("a Top 5 render with exactly 5 scenes reproduces the template's own rank order", () => {
    const badges = sceneNodes(build(top5CountdownTemplate(), 5).source).map((scene) => (scene.elements as Node[]).find((el) => String(el.name).startsWith("RankBadge"))!.text);
    expect(badges).toEqual(["第5位", "第4位", "第3位", "第2位", "第1位"]);
  });

  it("splits voice-timed caption segments into timed text nodes clamped to the scene", () => {
    const scenes = makeScenes(2);
    scenes[0]!.captionSegments = [
      { text: "一つ目", startMs: 0, endMs: 1500 },
      { text: "二つ目", startMs: 1500, endMs: 9000 },
    ];
    const composed = sceneNodes(build(newsRecapJpTemplate(), 2, scenes).source);
    const texts = childrenOf(composed[0]!, "text");
    expect(texts.map((el) => el.text)).toEqual(["一つ目", "二つ目"]);
    expect(texts.map((el) => el.name)).toEqual(["Subtitles-1", "Subtitles-1-2"]);
    expect(texts[1]!.time + texts[1]!.duration).toBeLessThanOrEqual(composed[0]!.duration + 1e-9);
  });

  it("trims a video with a preview source range, mutes video, and drops trim for images", () => {
    const scenes = makeScenes(3);
    scenes[0] = { ...scenes[0]!, mediaKind: "video", sourceStartMs: 2000, sourceDurationMs: 4000 };
    const composed = sceneNodes(build(newsRecapJpTemplate(), 3, scenes).source);
    const [video] = composed[0]!.elements as Node[];
    expect(video).toMatchObject({ trim_start: 2, trim_duration: 4, volume: "0%" });
    const [image] = composed[2]!.elements as Node[];
    expect(image).toMatchObject({ type: "image" });
    expect(image).not.toHaveProperty("trim_start");
    expect(image).not.toHaveProperty("volume");
  });

  it("applies Studio caption overrides on top of the cloned layout", () => {
    const overrides = { [DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily]: "Poppins", [DYNAMIC_STYLE_OPTION_KEYS.captionFillColor]: "#00ff00" };
    const composed = sceneNodes(build(newsRecapJpTemplate(), 3, makeScenes(3), overrides).source);
    for (const scene of composed) expect(childrenOf(scene, "text")[0]).toMatchObject({ font_family: "Poppins", fill_color: "#00ff00" });
  });

  it("adds narration audio, media and captions even when the prototype scene lacks those elements", () => {
    const minimal = { width: 1080, height: 1920, elements: [{ name: "Scene-1", type: "composition", duration: 3, elements: [{ name: "Bg", type: "shape" }] }] };
    const composed = sceneNodes(build(minimal, 3).source);
    expect(composed).toHaveLength(3);
    for (const scene of composed) {
      expect(childrenOf(scene, "audio")).toHaveLength(1);
      expect(childrenOf(scene, "text")).toHaveLength(1);
      expect((scene.elements as Node[]).some((el) => el.type === "video" || el.type === "image")).toBe(true);
    }
    expect(build(minimal, 3).warnings).toContain("no_caption_element");
  });

  it("does not mutate the pinned template (pure clone)", () => {
    const raw = top5CountdownTemplate();
    const before = JSON.stringify(raw);
    buildDynamicComposition(makeScenes(7), extractDynamicStyleFromTemplate(raw), { width: 1080, height: 1920 });
    expect(JSON.stringify(raw)).toBe(before);
  });
});
