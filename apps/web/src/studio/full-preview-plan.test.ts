import { describe, expect, it } from "vitest";
import { buildCaptionAss } from "@lyonix/domain/caption-ass";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "@lyonix/render-recipes";
import { locales } from "../i18n/locales";
import { buildFullPreviewSequence, type FullPreviewSceneInput } from "./full-preview";
import { buildPreviewPlan, layoutSceneCaption, pageAt } from "./full-preview-plan";

const scene = (id: string, over: Partial<FullPreviewSceneInput> = {}): FullPreviewSceneInput => ({
  sceneId: id, excluded: false, narration: "今日は天気がいいですね。", durationHintMs: 3000, mediaKind: "image", mediaUrl: `https://m/${id}.jpg`,
  sourceStartMs: null, sourceDurationMs: null, audioUrl: `https://a/${id}.mp3`, audioDurationMs: 3000, ...over,
});

describe("preview shares the render engine's caption layout (VE2E-114)", () => {
  const LONG = "政府は新しい経済対策を発表し、物価高への対応を急ぐ方針で、来月から実施される見通しです。政府は新しい経済対策を発表しました。";

  it("lays a caption out with exactly the lines/font size the render's buildCaptionAss produces", () => {
    for (const text of ["短い字幕です。", "政府は新しい経済対策を発表し、物価高への対応を急ぐ方針です。", LONG, "The government announced a new economic package on Monday to address rising prices"]) {
      const pages = layoutSceneCaption(text, 8000);
      const recipe = NEWS_RECAP_BROADCAST_TELOP_JP_V1;
      const reference = buildCaptionAss([{ text, startMs: 0, endMs: 8000 }], {
        canvas: { width: 1080, height: 1920 }, fps: 60, fontName: recipe.captions.fontFamily, fontSizePx: recipe.captions.fontSizePx, minFontSizePx: recipe.captions.minFontSizePx,
        maxLines: recipe.captions.maxLines, bold: recipe.captions.bold, highlight: "none",
      }).cues;
      expect(pages.map((p) => p.lines)).toEqual(reference.map((c) => c.lines));
      expect(pages.map((p) => p.fontSizePx)).toEqual(reference.map((c) => c.fontSizePx));
      expect(pages.every((p) => p.lines.length <= 2)).toBe(true);
      expect(pages.map((p) => p.lines.join("")).join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, "")); // the caption text is never altered, only broken
    }
  });

  it("splits a too-long caption into consecutive pages and picks the page by time; the last page stays to the end", () => {
    const pages = layoutSceneCaption(LONG, 9000);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.split)).toBe(true);
    expect(pageAt(pages, 0)).toBe(pages[0]);
    expect(pageAt(pages, pages[1]!.startMs + 1)).toBe(pages[1]);
    expect(pageAt(pages, 99_999)).toBe(pages.at(-1));
    expect(pageAt([], 100)).toBeNull();
    expect(layoutSceneCaption("   ", 3000)).toEqual([]);
    expect(layoutSceneCaption("x", 0)).toEqual([]);
  });

  it("builds the engine's RenderPlan from the preview: 60 fps frame-quantised timeline + recipe padding = expected render length", () => {
    const sequence = buildFullPreviewSequence([scene("a", { audioDurationMs: 3333 }), scene("b", { audioDurationMs: 4100 })]);
    const plan = buildPreviewPlan(sequence.segments);
    expect(plan.renderPlan?.fps).toBe(60);
    expect(plan.renderPlan?.canvas).toEqual({ width: 1080, height: 1920 });
    const { padStartMs, padEndMs } = NEWS_RECAP_BROADCAST_TELOP_JP_V1.timing;
    expect(Math.abs(plan.expectedRenderDurationMs! - (3333 + 4100 + padStartMs + padEndMs))).toBeLessThanOrEqual(100);
    expect(plan.renderPlan!.scenes[1]!.transitionIn).toEqual({ kind: "wipe", durationMs: 400 });
    expect(plan.skippedSceneIds).toEqual([]);
    expect(plan.captionPages.get("a")!.length).toBeGreaterThan(0);
  });

  it("scenes the engine would skip (no media / no voice) are reported and do not count towards the render length", () => {
    const sequence = buildFullPreviewSequence([scene("ok"), scene("novoice", { audioUrl: null, audioDurationMs: null }), scene("nomedia", { mediaUrl: null, mediaKind: null })]);
    const plan = buildPreviewPlan(sequence.segments);
    expect(plan.skippedSceneIds).toEqual(["novoice", "nomedia"]);
    expect(plan.renderPlan!.scenes.map((s) => s.sceneId)).toEqual(["ok"]);
    // the preview still lays out a caption for a scene without voice (hint duration) - it is shown in the player
    expect(plan.captionPages.get("novoice")!.length).toBeGreaterThan(0);
    const none = buildPreviewPlan(buildFullPreviewSequence([scene("x", { audioUrl: null, audioDurationMs: null })]).segments);
    expect(none).toMatchObject({ renderPlan: null, expectedRenderDurationMs: null, skippedSceneIds: ["x"] });
  });

  it("V03-03: a scene with voice-timed cues shows those cues at their own times, holding a cue through a pause", () => {
    const cues = [{ text: "東京の夜景。", startMs: 200, endMs: 1400 }, { text: "人が多い。", startMs: 2000, endMs: 3200 }];
    const sequence = buildFullPreviewSequence([scene("a", { audioDurationMs: 3500, captionCues: cues })]);
    expect(sequence.segments[0]!.captionCues).toEqual(cues);
    const plan = buildPreviewPlan(sequence.segments);
    const pages = plan.captionPages.get("a")!;
    expect(pages.map((page) => page.lines.join(""))).toEqual(["東京の夜景。", "人が多い。"]);
    expect(pageAt(pages, 1700)!.lines.join("")).toBe("東京の夜景。"); // pause between the two cues
    expect(pageAt(pages, 2100)!.lines.join("")).toBe("人が多い。");
    expect(plan.renderPlan!.scenes[0]!.captionCues.map((cue) => cue.text)).toEqual(["東京の夜景。", "人が多い。"]);
  });

  it("V03-03: cues are ignored for a scene without its voice (their times are relative to that voice)", () => {
    const sequence = buildFullPreviewSequence([scene("a", { audioUrl: null, audioDurationMs: null, captionCues: [{ text: "x", startMs: 0, endMs: 500 }] })]);
    expect(sequence.segments[0]!.captionCues).toBeNull();
  });

  it("has the new strings in every locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro;
      expect(strings.fullPreviewRenderDuration).toContain("{{duration}}");
      expect(strings.fullPreviewRenderDuration).toContain("{{fps}}");
      expect(strings.fullPreviewRenderSkipped).toContain("{{count}}");
    }
  });
});
