import { describe, expect, it } from "vitest";
import {
  assColor,
  buildCaptionAss,
  buildCaptionAssFromRenderPlan,
  CAPTION_SAFE_ZONE,
  charTimingsForSegments,
  formatAssTime,
  KINSOKU_LINE_START,
  measureWidthEm,
  segmentPhrases,
  snapToFrameMs,
} from "./caption-ass.js";
import { buildRenderPlan } from "./render-plan.js";

const FRAME = 1000 / 60;
const events = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
const plain = (event: string) => event.split(",,").pop()!.replace(/\{[^}]*\}/g, "").split("\\N");

describe("caption-ass (VE2E-103)", () => {
  it("segments Japanese with BudouX and latin text into words; the pieces always re-join to the text", () => {
    const text = "政府は新しい経済対策を発表し、物価高への対応を急ぐ方針です。";
    const phrases = segmentPhrases(text);
    expect(phrases.join("")).toBe(text);
    expect(phrases.length).toBeGreaterThan(3);
    expect(phrases).toContain("経済対策を");
    expect(segmentPhrases("Hello big world").join("")).toBe("Hello big world");
    expect(segmentPhrases("Hello big world")).toEqual(["Hello ", "big ", "world"]);
  });

  it("keeps a short Japanese sentence on one line at the base size", () => {
    const result = buildCaptionAss([{ text: "今日は天気がいいですね。", startMs: 0, endMs: 2000 }]);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.lines).toEqual(["今日は天気がいいですね。"]);
    expect(result.cues[0]!.fontSizePx).toBe(64);
  });

  it("wraps a long sentence to at most 2 lines and never breaks inside a BudouX phrase when phrases fit", () => {
    const text = "政府は新しい経済対策を発表し、物価高への対応を急ぐ方針です。";
    expect(Array.from(text).length).toBe(30);
    const result = buildCaptionAss([{ text, startMs: 0, endMs: 6000 }]);
    expect(result.cues).toHaveLength(1);
    const cue = result.cues[0]!;
    expect(cue.lines).toHaveLength(2);
    expect(cue.lines.length).toBeLessThanOrEqual(2);
    expect(cue.lines.join("")).toBe(text);
    const phrases = segmentPhrases(text);
    // every line boundary coincides with a phrase boundary
    let consumed = 0;
    const boundaries = new Set(phrases.map((p) => (consumed += p.length)));
    let at = 0;
    for (const line of cue.lines.slice(0, -1)) {
      at += line.length;
      expect(boundaries.has(at)).toBe(true);
    }
  });

  it("never starts a line with kinsoku punctuation nor ends one with an opening bracket", () => {
    const samples = [
      "これは長い文章の途中で改行が入る可能性があるテスト用の文章です。そうですね！",
      "「速報です」と政府は発表した。「詳細は後ほど」と述べた（午後三時）。",
      "新しい経済対策が発表され、物価高への対応が急がれる中、各社は「値上げ」を見送った。",
    ];
    for (const text of samples) {
      for (const width of [1080, 900]) {
        const { cues } = buildCaptionAss([{ text, startMs: 0, endMs: 5000 }], { canvas: { width, height: 1920 } });
        for (const cue of cues) {
          for (const line of cue.lines.slice(1)) expect(KINSOKU_LINE_START.includes(line[0]!), `"${line}" starts with ${line[0]}`).toBe(false);
          for (const line of cue.lines.slice(0, -1)) expect("「『（".includes(line.at(-1)!), `"${line}" ends with opening bracket`).toBe(false);
        }
      }
    }
  });

  it("shrinks the font before splitting, and splits at phrase boundaries with consecutive times when the minimum size is not enough", () => {
    const long = "政府は新しい経済対策を発表し、物価高への対応を急ぐ方針で、来月から実施される見通しです。".repeat(3);
    const { cues, warnings } = buildCaptionAss([{ text: long, startMs: 1000, endMs: 13000 }]);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((c) => c.lines.length <= 2)).toBe(true);
    expect(cues.every((c) => c.fontSizePx === 44)).toBe(true);
    expect(cues.every((c) => c.split)).toBe(true);
    expect(warnings.length).toBe(1);
    // text preserved exactly, order preserved
    expect(cues.map((c) => c.lines.join("")).join("")).toBe(long);
    // consecutive and gap-free inside the original cue
    expect(cues[0]!.startMs).toBeCloseTo(snapToFrameMs(1000, 60), 5);
    for (let i = 1; i < cues.length; i += 1) expect(cues[i]!.startMs).toBeCloseTo(cues[i - 1]!.endMs, 5);
    expect(cues.at(-1)!.endMs).toBeCloseTo(snapToFrameMs(13000, 60), 5);
  });

  it("shrinks only as much as needed for a sentence that fits in 2 lines at a smaller size", () => {
    const text = "政府は新しい経済対策を発表し、物価高への対応を急ぐ方針です。";
    const { cues } = buildCaptionAss([{ text, startMs: 0, endMs: 6000 }], { fontSizePx: 88, minFontSizePx: 44 });
    expect(cues).toHaveLength(1);
    expect(cues[0]!.fontSizePx).toBeLessThan(88);
    expect(cues[0]!.fontSizePx).toBeGreaterThanOrEqual(44);
    expect(cues[0]!.lines.length).toBeLessThanOrEqual(2);
  });

  it("wraps English/Vietnamese at spaces only", () => {
    const en = "The government announced a new economic package on Monday to address rising prices across the country";
    const vi = "Chính phủ vừa công bố gói kích thích kinh tế mới nhằm đối phó với tình trạng giá cả leo thang";
    for (const text of [en, vi]) {
      const { cues } = buildCaptionAss([{ text, startMs: 0, endMs: 6000 }]);
      expect(cues.length).toBeGreaterThanOrEqual(1);
      for (const cue of cues) {
        expect(cue.lines.length).toBeLessThanOrEqual(2);
        for (const word of cue.lines.join(" ").split(" ")) expect(text.split(" ")).toContain(word);
      }
      expect(cues.map((c) => c.lines.join(" ")).join(" ")).toBe(text);
    }
  });

  it("puts every event on the 60 fps frame grid (<= 5 ms ASS rounding) with no overlaps, and never drops a cue shorter than a frame", () => {
    const result = buildCaptionAss([
      { text: "一つ目の字幕です。", startMs: 1234, endMs: 3456 },
      { text: "二つ目の字幕です。", startMs: 3400, endMs: 3405 },
      { text: "三つ目の字幕です。", startMs: 5000, endMs: 7777 },
    ]);
    expect(result.cues).toHaveLength(3);
    for (const cue of result.cues) {
      expect(Math.abs((cue.startMs / FRAME) - Math.round(cue.startMs / FRAME))).toBeLessThan(1e-6);
      expect(Math.abs((cue.endMs / FRAME) - Math.round(cue.endMs / FRAME))).toBeLessThan(1e-6);
      expect(cue.endMs - cue.startMs).toBeGreaterThanOrEqual(FRAME - 0.01);
    }
    for (let i = 1; i < result.cues.length; i += 1) expect(result.cues[i]!.startMs).toBeGreaterThanOrEqual(result.cues[i - 1]!.endMs - 1e-6);
    expect(formatAssTime(1234)).toBe("0:00:01.23");
    expect(formatAssTime(3_661_500)).toBe("1:01:01.50");
  });

  it("writes Style margins from the safe zone and a bottom-centre alignment", () => {
    const { ass } = buildCaptionAss([{ text: "テスト", startMs: 0, endMs: 1000 }]);
    const style = ass.split("\n").find((l) => l.startsWith("Style:"))!.split(",");
    expect(style[18]).toBe("2"); // Alignment bottom centre
    expect(Number(style[19])).toBe(Math.round(1080 * CAPTION_SAFE_ZONE.side));
    expect(Number(style[21])).toBe(Math.round(1920 * CAPTION_SAFE_ZONE.bottom));
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toContain("WrapStyle: 2");
  });

  it("highlights per phrase with \\k whose total spans the real alignment timing; estimated timing is flagged", () => {
    const text = "今日は天気がいいですね。";
    const phrases = segmentPhrases(text);
    const chars = Array.from(text);
    const charTimings = chars.map((_, i) => ({ startMs: 1000 + i * 200, endMs: 1000 + (i + 1) * 200 }));
    const aligned = buildCaptionAss([{ text, startMs: 1000, endMs: 1000 + chars.length * 200, charTimings }]);
    expect(aligned.cues[0]!.timing).toBe("alignment");
    const body = events(aligned.ass)[0]!;
    const ks = [...body.matchAll(/\{\\k(\d+)\}/g)].map((m) => Number(m[1]));
    expect(ks.length).toBe(phrases.length);
    expect(ks.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(Math.round((chars.length * 200) / 10) - 2);
    expect(ks.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(Math.round((chars.length * 200) / 10) + 2);
    expect(plain(body).join("")).toBe(text);

    const estimated = buildCaptionAss([{ text, startMs: 1000, endMs: 3400 }]);
    expect(estimated.cues[0]!.timing).toBe("estimated");

    const off = buildCaptionAss([{ text, startMs: 1000, endMs: 3400 }], { highlight: "none" });
    expect(events(off.ass)[0]).not.toContain("\\k");
  });

  it("inserts a gap tag for silence between phrases so highlights stay on the real timing", () => {
    const text = "あい うえ";
    const chars = Array.from(text);
    // "あい" spoken 0-400ms, 600ms pause, "うえ" spoken 1000-1400ms
    const timings = [0, 200, 400, 1000, 1200].map((s, i) => ({ startMs: s, endMs: i === 2 ? 400 : s + 200 }));
    const result = buildCaptionAss([{ text, startMs: 0, endMs: 1400, charTimings: timings }], { locale: "latin" });
    const body = events(result.ass)[0]!;
    expect(chars).toHaveLength(5);
    expect(body).toMatch(/\{\\k\d+\}\{\\k\d+\}/);
  });

  it("neutralises ASS override characters in the text", () => {
    const { ass } = buildCaptionAss([{ text: "a{\\b1}b", startMs: 0, endMs: 1000 }], { highlight: "none" });
    const text = events(ass)[0]!.split(",,").pop()!;
    expect(text).not.toContain("{");
    expect(text).not.toContain("\\b1");
  });

  it("measures CJK as 1 em and latin narrower", () => {
    expect(measureWidthEm("日本語")).toBe(3);
    expect(measureWidthEm("abc")).toBeLessThan(3);
    expect(assColor("#FFD400")).toBe("&H0000D4FF");
  });

  it("maps caption segments onto a character alignment, or null when the text does not match", () => {
    const text = "Hi there";
    const characters = Array.from(text);
    const alignment = {
      characters,
      characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
      characterEndTimesSeconds: characters.map((_, i) => i * 0.1 + 0.1),
    };
    const [a, b] = charTimingsForSegments(alignment, [{ text: "Hi" }, { text: "there" }]);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(5);
    expect(b![0]!.startMs).toBe(300);
    expect(charTimingsForSegments(alignment, [{ text: "Hello" }])).toEqual([null]);
  });

  it("V03-03: never puts more than 2 lines on screen at once - long cues are split into back-to-back cues instead", () => {
    const texts = [
      "東京の夜景はとても美しく、毎晩たくさんの観光客が展望台に集まって写真を撮っています。週末にはさらに人が増え、駅前の通りは夜遅くまでにぎやかです。",
      "Messi đã chính thức chuyển tới Inter Miami sau nhiều năm thi đấu tại châu Âu, mở ra một chương mới đầy hứa hẹn trong sự nghiệp của anh.",
      "Supercalifragilisticexpialidociousandevenlongerwordswithoutanyspacesatallthatcannotbebrokenbyphrase",
    ];
    const { cues } = buildCaptionAss(texts.map((text, i) => ({ text, startMs: i * 10_000, endMs: i * 10_000 + 9_000 })), { maxLines: 2 });
    expect(cues.length).toBeGreaterThan(texts.length);
    for (const cue of cues) expect(cue.lines.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < cues.length; i += 1) expect(cues[i]!.startMs).toBeGreaterThanOrEqual(cues[i - 1]!.endMs);
  });

  it("V03-03: a user-edited cue gets null timing, but the cues after it keep their real alignment timing", () => {
    const text = "Hi there you"; // H0 i1 _2 t3 h4 e5 r6 e7 _8 y9 o10 u11, 100 ms per character
    const characters = Array.from(text);
    const alignment = {
      characters,
      characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
      characterEndTimesSeconds: characters.map((_, i) => i * 0.1 + 0.1),
    };
    const [a, b, c] = charTimingsForSegments(alignment, [
      { text: "Hi", endMs: 200 },
      { text: "THERE!", endMs: 800 }, // edited: no longer what was voiced
      { text: "you", endMs: 1200 },
    ]);
    expect(a).toHaveLength(2);
    expect(b).toBeNull();
    expect(c).toHaveLength(3);
    expect(c![0]!.startMs).toBe(900);
  });

  it("builds captions from a RenderPlan on the absolute timeline (voice-timed cues and static override text)", () => {
    const plan = buildRenderPlan({
      scenes: [
        { sceneId: "a", orderIndex: 0, mediaAssetVersionId: "m1", mediaKind: "image", audioAssetVersionId: "v1", audioDurationMs: 3000, captionSegments: [{ text: "最初の字幕", startMs: 100, endMs: 2900 }] },
        { sceneId: "b", orderIndex: 1, mediaAssetVersionId: "m2", mediaKind: "image", audioAssetVersionId: "v2", audioDurationMs: 2000, screenTextOverride: "手入力の文字" },
      ],
      profile: { padStartMs: 500 },
    });
    if (!plan.ok) throw new Error("plan");
    const { cues } = buildCaptionAssFromRenderPlan(plan.plan);
    expect(cues.map((c) => c.lines.join(""))).toEqual(["最初の字幕", "手入力の文字"]);
    expect(cues[0]!.startMs).toBeCloseTo(snapToFrameMs(500 + 100, 60), 5);
    expect(cues[1]!.startMs).toBeGreaterThanOrEqual(3500 - 20);
  });

  it("anchors captions at the top (Alignment 8, MarginV from the percent) or the bottom (Alignment 2) and paints per-cue colours (VE2E-115)", () => {
    const cue = { text: "今日は天気がいいですね。", startMs: 0, endMs: 2000 };
    const top = buildCaptionAss([cue], { verticalAnchor: "top", marginVPercent: 12, highlight: "none" }).ass;
    const style = /Style: Sub,.*/.exec(top)![0].split(",");
    expect(style[18]).toBe("8");
    expect(Number(style[21])).toBe(Math.round(1920 * 0.12));
    const bottom = buildCaptionAss([cue], { highlight: "none" }).ass;
    expect(/Style: Sub,.*/.exec(bottom)![0].split(",")[18]).toBe("2");
    const coloured = buildCaptionAss([{ ...cue, color: "#FFE600" }], { highlight: "none" }).ass;
    expect(coloured).toContain("{\\1c&H00E6FF&}");
    expect(buildCaptionAss([cue], { highlight: "none" }).ass).not.toContain("\\1c&H");
  });
});
