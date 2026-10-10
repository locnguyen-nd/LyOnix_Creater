import { describe, expect, it } from "vitest";
import { summarizeVideoCost, usdOf } from "./video-cost.js";

describe("usdOf", () => {
  it("accepts a recorded USD amount (string, number or a Decimal-like) and nothing else", () => {
    expect(usdOf({ costAmount: "0.0421", costCurrency: "USD" })).toBe(0.0421);
    expect(usdOf({ costAmount: 0.5, costCurrency: "usd" })).toBe(0.5);
    expect(usdOf({ costAmount: { toString: () => "1.25" }, costCurrency: " USD " })).toBe(1.25);
    expect(usdOf({ costAmount: "0", costCurrency: "USD" })).toBe(0);
  });

  it("ignores a missing amount, a missing or other currency, junk and negatives", () => {
    expect(usdOf(null)).toBeNull();
    expect(usdOf({ costAmount: null, costCurrency: "USD" })).toBeNull();
    expect(usdOf({ costAmount: "1", costCurrency: null })).toBeNull();
    expect(usdOf({ costAmount: "1", costCurrency: "credits" })).toBeNull();
    expect(usdOf({ costAmount: "abc", costCurrency: "USD" })).toBeNull();
    expect(usdOf({ costAmount: "-2", costCurrency: "USD" })).toBeNull();
  });
});

describe("summarizeVideoCost", () => {
  it("adds render, content, voice and Apify spend and keeps each part", () => {
    const cost = summarizeVideoCost({
      render: { costAmount: "0.0100", costCurrency: "USD" },
      usage: [
        { kind: "content", costAmount: "0.0200", costCurrency: "USD" },
        { kind: "content", costAmount: "0.0050", costCurrency: "USD" },
        { kind: "tts", costAmount: "0.0300", costCurrency: "USD" },
      ],
      apifyUsd: 0.94,
    });
    expect(cost).toEqual({ totalUsd: 1.005, renderUsd: 0.01, contentUsd: 0.025, ttsUsd: 0.03, mediaUsd: 0.94 });
  });

  it("a part nobody recorded stays null and is not counted as zero", () => {
    expect(summarizeVideoCost({ render: { costAmount: "0.5", costCurrency: "USD" } })).toEqual({ totalUsd: 0.5, renderUsd: 0.5, contentUsd: null, ttsUsd: null, mediaUsd: null });
    expect(summarizeVideoCost({ usage: [{ kind: "tts", costAmount: null, costCurrency: null }] })).toEqual({ totalUsd: null, renderUsd: null, contentUsd: null, ttsUsd: null, mediaUsd: null });
    expect(summarizeVideoCost({})).toEqual({ totalUsd: null, renderUsd: null, contentUsd: null, ttsUsd: null, mediaUsd: null });
  });

  it("an amount in another currency is left out of every part", () => {
    const cost = summarizeVideoCost({ render: { costAmount: "87", costCurrency: "credits" }, usage: [{ kind: "content", costAmount: "0.01", costCurrency: "USD" }] });
    expect(cost).toEqual({ totalUsd: 0.01, renderUsd: null, contentUsd: 0.01, ttsUsd: null, mediaUsd: null });
  });

  it("a recorded zero is a real zero (an internal render that cost nothing), and a bad Apify figure is dropped", () => {
    expect(summarizeVideoCost({ render: { costAmount: "0", costCurrency: "USD" }, apifyUsd: Number.NaN })).toEqual({ totalUsd: 0, renderUsd: 0, contentUsd: null, ttsUsd: null, mediaUsd: null });
  });

  it("rounds to four decimals", () => {
    expect(summarizeVideoCost({ usage: [{ kind: "content", costAmount: "0.1", costCurrency: "USD" }, { kind: "content", costAmount: "0.2", costCurrency: "USD" }] }).contentUsd).toBe(0.3);
  });
});
