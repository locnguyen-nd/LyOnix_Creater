import { describe, expect, it } from "vitest";
import { buildCaptionAss, entranceTags } from "./caption-ass.js";

const dialogues = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue:"));

describe("VE2E-157 caption / overlay entrance (libass tags)", () => {
  it("entranceTags: fade, then the pop as a scale transform; nothing without an entrance", () => {
    expect(entranceTags(undefined)).toBe("");
    expect(entranceTags({ fadeInMs: 90 })).toBe("{\\fad(90,0)}");
    expect(entranceTags({ fadeInMs: 90, popFromPct: 92, popMs: 150 })).toBe("{\\fad(90,0)\\fscx92\\fscy92\\t(0,150,\\fscx100\\fscy100)}");
    expect(entranceTags({ fadeInMs: 450, fadeOutMs: 300, popFromPct: 100, popMs: 0 })).toBe("{\\fad(450,300)}");
  });

  it("every caption event (each phrase, also the pages of a split cue) gets the entrance; timing and text are unchanged", () => {
    const cues = [
      { text: "今日の注目ニュースを", startMs: 0, endMs: 1200 },
      { text: "わかりやすく紹介します。", startMs: 1200, endMs: 2800 },
    ];
    const plain = buildCaptionAss(cues, { highlight: "none" });
    const moving = buildCaptionAss(cues, { highlight: "none", entrance: { fadeInMs: 90, popFromPct: 92, popMs: 150 } });
    expect(dialogues(moving.ass)).toHaveLength(2);
    for (const line of dialogues(moving.ass)) expect(line).toContain("{\\fad(90,0)\\fscx92\\fscy92\\t(0,150,\\fscx100\\fscy100)}");
    expect(moving.ass.replaceAll("{\\fad(90,0)\\fscx92\\fscy92\\t(0,150,\\fscx100\\fscy100)}", "")).toBe(plain.ass);
    expect(moving.cues).toEqual(plain.cues);
  });

  it("a placed layer that rises moves from risePx below into its centre over the fade; word highlight (\\k) still follows the voice", () => {
    const layer = buildCaptionAss([{ text: "速報", startMs: 250, endMs: 9000 }], { highlight: "none", placement: { x: 540, y: 216, widthPx: 820 }, entrance: { fadeInMs: 450, fadeOutMs: 300, risePx: 28 } });
    expect(dialogues(layer.ass)[0]).toContain("{\\an5\\move(540,244,540,216,0,450)}{\\fad(450,300)}");
    const karaoke = buildCaptionAss([{ text: "Messi is here", startMs: 0, endMs: 1500 }], { highlight: "word", entrance: { fadeInMs: 90, popFromPct: 92, popMs: 150 } });
    expect(dialogues(karaoke.ass)[0]).toMatch(/\\fad\(90,0\).*\\k\d+/);
  });
});
