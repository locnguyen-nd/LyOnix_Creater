import { describe, expect, it } from "vitest";
import { buildOrshotEmbedUrl, compactOrshotOptions, elapsedLabel, formatUsd, hasBlockingSlotMismatch, orshotEmbedIdOf, parseOrshotEmbedMessage, slotCompatibility } from "./orshot-embed";

describe("orshotEmbedIdOf / buildOrshotEmbedUrl", () => {
  it("treats n/a, empty and unsafe ids as not configured", () => {
    for (const bad of ["n/a", "", null, undefined, "a/b", "ab", "x y"]) expect(orshotEmbedIdOf(bad as string)).toBeNull();
    expect(orshotEmbedIdOf("emb_123-AB")).toBe("emb_123-AB");
  });
  it("builds the embed URL with encoded query params and refuses unsafe ids", () => {
    expect(buildOrshotEmbedUrl("emb123", { templateId: "42", lang: "vi", userId: "u 1" })).toBe("https://orshot.com/embeds/emb123?templateId=42&lang=vi&userId=u+1");
    expect(buildOrshotEmbedUrl("emb123")).toBe("https://orshot.com/embeds/emb123");
    expect(buildOrshotEmbedUrl("../evil")).toBeNull();
  });
});

describe("parseOrshotEmbedMessage", () => {
  const frame = {};
  it("only trusts https://orshot.com", () => {
    expect(parseOrshotEmbedMessage({ origin: "https://evil.example", data: { type: "orshot:embed:ready" } })).toBeNull();
    expect(parseOrshotEmbedMessage({ origin: "http://orshot.com", data: { type: "orshot:embed:ready" } })).toBeNull();
    expect(parseOrshotEmbedMessage({ origin: "https://orshot.com.evil.io", data: { type: "orshot:embed:ready" } })).toBeNull();
  });
  it("requires the message to come from the embed iframe when its window is given", () => {
    expect(parseOrshotEmbedMessage({ origin: "https://orshot.com", data: { type: "orshot:template:create" }, source: {} }, frame)).toBeNull();
    expect(parseOrshotEmbedMessage({ origin: "https://orshot.com", data: { type: "orshot:template:create" }, source: frame }, frame)).toEqual({ kind: "template-created" });
  });
  it("maps ready (with/without eventsEnabled) and template events, ignores junk", () => {
    const ok = (data: unknown) => parseOrshotEmbedMessage({ origin: "https://orshot.com", data });
    expect(ok({ type: "orshot:embed:ready", data: { eventsEnabled: false } })).toEqual({ kind: "ready", eventsEnabled: false });
    expect(ok({ type: "orshot:embed:ready" })).toEqual({ kind: "ready", eventsEnabled: null });
    expect(ok({ type: "orshot:template:update" })).toEqual({ kind: "template-updated" });
    expect(ok({ type: "orshot:template:content" })).toEqual({ kind: "template-content" });
    for (const junk of [null, "str", 5, {}, { type: 7 }, { type: "other" }]) expect(ok(junk)).toBeNull();
  });
});

describe("slotCompatibility", () => {
  const slots = [{ kind: "video" }, { kind: "video" }, { kind: "text" }, { kind: "text" }, { kind: "audio" }] as const;
  const row = (rows: ReturnType<typeof slotCompatibility>, kind: string) => rows.find((r) => r.kind === kind)!;
  it("counts subtitle and tag for each Orshot page", () => {
    const pages = [1, 2].flatMap((page) => [
      { key: `page${page}@media`, kind: "video" as const },
      { key: `page${page}@subtitle`, kind: "text" as const },
      { key: `page${page}@tag`, kind: "text" as const },
    ]);
    expect(row(slotCompatibility(pages, { scenes: 2, videos: 2, images: 0, voices: 0 }), "text")).toMatchObject({ templateSlots: 4, timelineItems: 4, status: "ok" });
  });
  it("flags missing required slots (blocking) and unused surplus scenes", () => {
    const rows = slotCompatibility([...slots], { scenes: 3, videos: 1, images: 0, voices: 0 });
    expect(row(rows, "video")).toMatchObject({ templateSlots: 2, timelineItems: 1, status: "missing" });
    expect(row(rows, "text").status).toBe("unused");
    expect(row(rows, "audio").status).toBe("ok");
    expect(hasBlockingSlotMismatch(rows)).toBe(true);
  });
  it("is clean when counts line up; an unused media kind is only a hint", () => {
    const rows = slotCompatibility([...slots], { scenes: 2, videos: 2, images: 1, voices: 2 });
    expect(rows.map((r) => r.status)).toEqual(["ok", "unused", "ok", "unused"]);
    expect(hasBlockingSlotMismatch(rows)).toBe(false);
  });
});

describe("display helpers", () => {
  it("compacts options and keeps fit-to-narration on by default", () => {
    expect(compactOrshotOptions({ size: "" })).toEqual({ fitDurationToNarration: true });
    expect(compactOrshotOptions({ format: "webm", fps: 60, size: "tiktok-video", fitDurationToNarration: false })).toEqual({ format: "webm", fps: 60, size: "tiktok-video", fitDurationToNarration: false });
  });
  it("formats USD estimates", () => {
    expect(formatUsd("0.1040")).toBe("$0.10");
    expect(formatUsd("0.0032")).toBe("$0.0032");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd("0")).toBe("$0.00");
  });
  it("formats elapsed time", () => {
    const now = Date.parse("2026-01-01T00:02:05Z");
    expect(elapsedLabel("2026-01-01T00:02:00Z", now)).toBe("5s");
    expect(elapsedLabel("2026-01-01T00:00:00Z", now)).toBe("2m 05s");
  });
});
