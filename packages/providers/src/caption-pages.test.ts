import { describe, expect, it } from "vitest";
import { MAX_CAPTION_LINES, creatomateLengthPx, paginateCaptionBlocks } from "./caption-pages.js";

const canvas = { width: 1080, height: 1920 };

describe("creatomateLengthPx (V03-03)", () => {
  it("converts Creatomate units to canvas pixels", () => {
    expect(creatomateLengthPx("8 vmin", canvas, null)).toBeCloseTo(86.4);
    expect(creatomateLengthPx("10vw", canvas, null)).toBeCloseTo(108);
    expect(creatomateLengthPx("5 vh", canvas, null)).toBeCloseTo(96);
    expect(creatomateLengthPx("64 px", canvas, null)).toBe(64);
    expect(creatomateLengthPx("64", canvas, null)).toBe(64);
    expect(creatomateLengthPx("86%", canvas, 1080)).toBeCloseTo(928.8);
  });

  it("returns null for an unknown unit, a percent font size or garbage", () => {
    expect(creatomateLengthPx("12 em", canvas, null)).toBeNull();
    expect(creatomateLengthPx("50%", canvas, null)).toBeNull();
    expect(creatomateLengthPx(undefined, canvas, null)).toBeNull();
    expect(creatomateLengthPx("auto", canvas, 1080)).toBeNull();
  });
});

describe("paginateCaptionBlocks (V03-03: at most 2 lines at a time)", () => {
  const box = { fontSize: "8 vmin", width: "86%" };

  it("keeps a short block as one page with its exact timing", () => {
    expect(paginateCaptionBlocks([{ text: "Hook", time: 1.2, duration: 2 }], box, canvas)).toEqual([{ text: "Hook", time: 1.2, duration: 2 }]);
  });

  it("splits a long Vietnamese block into back-to-back pages of at most 2 lines with all the words kept", () => {
    const text = "Messi đã chính thức chuyển tới Inter Miami sau nhiều năm thi đấu tại châu Âu, mở ra một chương mới trong sự nghiệp của anh.";
    const pages = paginateCaptionBlocks([{ text, time: 0, duration: 9 }], box, canvas);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.text.split("\n").length).toBeLessThanOrEqual(MAX_CAPTION_LINES);
    expect(pages.map((page) => page.text.replace(/\n/g, " ")).join(" ")).toBe(text);
    expect(pages[0]!.time).toBe(0);
    expect(pages.at(-1)!.time + pages.at(-1)!.duration).toBeCloseTo(9, 5);
  });

  it("fits more text per page in a wider box or with a smaller font", () => {
    const text = "東京の夜景はとても美しく、毎晩たくさんの観光客が展望台に集まって写真を撮っています。";
    const big = paginateCaptionBlocks([{ text, time: 0, duration: 6 }], { fontSize: "10 vmin", width: "70%" }, canvas);
    const small = paginateCaptionBlocks([{ text, time: 0, duration: 6 }], { fontSize: "6 vmin", width: "90%" }, canvas);
    expect(small.length).toBeLessThan(big.length);
  });

  it("falls back to the default font and width for unknown units and skips empty blocks", () => {
    const pages = paginateCaptionBlocks([{ text: "  ", time: 0, duration: 1 }, { text: "Xin chào", time: 1, duration: 1 }], { fontSize: "50%", width: "auto" }, canvas);
    expect(pages).toEqual([{ text: "Xin chào", time: 1, duration: 1 }]);
  });
});
