import { describe, expect, it } from "vitest";
import { estimateOrshotCost, narrationDurationMs, resolveOrshotPricing, sanitizeOrshotOptions } from "./orshot-render.js";

describe("resolveOrshotPricing", () => {
  it("defaults to the Grow plan (160 USD / 20000 credits) and 180 s ceiling", () => {
    expect(resolveOrshotPricing({})).toEqual({ creditUsd: 0.008, maxVideoSeconds: 180 });
  });
  it("reads env overrides and ignores invalid values", () => {
    expect(resolveOrshotPricing({ ORSHOT_CREDIT_USD: "0.026", ORSHOT_MAX_VIDEO_SECONDS: "300" })).toEqual({ creditUsd: 0.026, maxVideoSeconds: 300 });
    expect(resolveOrshotPricing({ ORSHOT_CREDIT_USD: "abc", ORSHOT_MAX_VIDEO_SECONDS: "-5" })).toEqual({ creditUsd: 0.008, maxVideoSeconds: 180 });
    expect(resolveOrshotPricing({ ORSHOT_CREDIT_USD: "  ", ORSHOT_MAX_VIDEO_SECONDS: "0" })).toEqual({ creditUsd: 0.008, maxVideoSeconds: 180 });
  });
});

describe("sanitizeOrshotOptions", () => {
  it("accepts undefined/null as empty options", () => {
    expect(sanitizeOrshotOptions(undefined)).toEqual({ ok: true, data: {} });
    expect(sanitizeOrshotOptions(null)).toEqual({ ok: true, data: {} });
  });
  it("keeps only whitelisted keys", () => {
    const out = sanitizeOrshotOptions({ format: "webm", fps: 60, size: "tiktok-video", fitDurationToNarration: false, apiKey: "leak", webhook_url: "https://evil" });
    expect(out).toEqual({ ok: true, data: { format: "webm", fps: 60, size: "tiktok-video", fitDurationToNarration: false } });
  });
  it("treats an empty size as unset and coerces fit flag to boolean", () => {
    expect(sanitizeOrshotOptions({ size: "", fitDurationToNarration: "yes" })).toEqual({ ok: true, data: { fitDurationToNarration: false } });
  });
  it("rejects bad shapes and unsupported values", () => {
    expect(sanitizeOrshotOptions("x")).toMatchObject({ ok: false });
    expect(sanitizeOrshotOptions([])).toMatchObject({ ok: false });
    expect(sanitizeOrshotOptions({ format: "avi" })).toMatchObject({ ok: false, message: expect.stringContaining("avi") });
    expect(sanitizeOrshotOptions({ fps: 25 })).toMatchObject({ ok: false });
    expect(sanitizeOrshotOptions({ size: "custom-1x1" })).toMatchObject({ ok: false });
  });
});

describe("estimateOrshotCost", () => {
  const pricing = { creditUsd: 0.008, maxVideoSeconds: 180 };
  it("rounds seconds up: 1 credit per started second", () => {
    expect(estimateOrshotCost(12_001, pricing)).toMatchObject({ durationSec: 13, credits: 13, amountUsd: "0.1040", exceedsPlanLimit: false });
  });
  it("is zero for no narration", () => {
    expect(estimateOrshotCost(0, pricing)).toMatchObject({ durationSec: 0, credits: 0, amountUsd: "0.0000" });
    expect(estimateOrshotCost(-5, pricing).durationSec).toBe(0);
  });
  it("flags only strictly-over-ceiling durations", () => {
    expect(estimateOrshotCost(180_000, pricing).exceedsPlanLimit).toBe(false);
    expect(estimateOrshotCost(180_001, pricing).exceedsPlanLimit).toBe(true);
  });
});

describe("narrationDurationMs", () => {
  it("sums included scenes and ignores excluded or missing audio", () => {
    expect(narrationDurationMs([{ audioDurationMs: 4000 }, { excluded: true, audioDurationMs: 9000 }, { audioDurationMs: null }, {}, { audioDurationMs: 1500 }])).toBe(5500);
  });
});
