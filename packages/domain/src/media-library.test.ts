import { describe, expect, it } from "vitest";
import {
  blockedByRepeatWindow,
  buildLibraryTags,
  libraryMinScoreFromEnv,
  readLibraryTags,
  recentJobKeys,
  repeatWindowFromEnv,
  scoreLibraryMatch,
  usedInWindow,
  type RepeatCandidate,
} from "./media-library.js";

const NOW = new Date("2026-10-07T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const cand = (id: string, usages: Array<[string, number]>, extra: Partial<RepeatCandidate> = {}): RepeatCandidate => ({ assetId: id, checksumSha256: `sum-${id}`, externalId: `ext-${id}`, author: null, usages: usages.map(([jobKey, d]) => ({ jobKey, at: daysAgo(d) })), ...extra });

describe("VE2E-135 library tags + match", () => {
  const tags = buildLibraryTags({ ja: ["東京夜景"], en: ["tokyo night"], broad: ["city lights"], subject: "Aespa", aliases: ["エスパ"], caption: "Night walk #tokyo #aespa", now: NOW });

  it("builds tags: shortened caption, hashtags extracted, ja/en/subject kept", () => {
    expect(tags.caption).toBe("Night walk");
    expect(tags.hashtags).toEqual(expect.arrayContaining(["tokyo", "aespa"]));
    expect(tags.ja).toEqual(["東京夜景"]);
    expect(tags.via).toBe("plan");
    expect(readLibraryTags({ library: JSON.parse(JSON.stringify(tags)) })).toEqual(tags);
    expect(readLibraryTags({})).toBeNull();
    expect(readLibraryTags(null)).toBeNull();
  });

  it("subject + keyword match scores high; unrelated scores 0", () => {
    expect(scoreLibraryMatch({ ja: ["東京夜景"], en: ["tokyo night"], broad: [], subject: "aespa", aliases: [] }, tags)).toBe(1);
    expect(scoreLibraryMatch({ ja: ["海"], en: ["beach"], broad: [], subject: "someone else", aliases: [] }, tags)).toBe(0);
  });

  it("wrong subject cannot pass the default threshold on keywords alone; alias hit counts as subject", () => {
    const min = libraryMinScoreFromEnv({});
    expect(scoreLibraryMatch({ ja: ["東京夜景"], en: ["tokyo night"], broad: [], subject: "Other", aliases: [] }, tags)).toBeLessThan(min);
    expect(scoreLibraryMatch({ ja: ["東京夜景"], en: [], broad: [], subject: "Foo", aliases: ["エスパ"] }, tags)).toBeGreaterThanOrEqual(min);
  });

  it("without a subject the keywords carry the score; empty query = 0", () => {
    expect(scoreLibraryMatch({ ja: ["東京夜景"], en: ["beach"], broad: [], subject: null, aliases: [] }, tags)).toBe(0.5);
    expect(scoreLibraryMatch({ ja: [], en: [], broad: [], subject: null, aliases: [] }, tags)).toBe(0);
  });

  it("threshold from env (valid only), default 0.6", () => {
    expect(libraryMinScoreFromEnv({})).toBe(0.6);
    expect(libraryMinScoreFromEnv({ MEDIA_LIBRARY_MIN_SCORE: "0.8" })).toBe(0.8);
    expect(libraryMinScoreFromEnv({ MEDIA_LIBRARY_MIN_SCORE: "5" })).toBe(0.6);
  });
});

describe("VE2E-135 repeat window", () => {
  const window = { days: 7, videos: 20 };

  it("env defaults to 7 days / 20 videos", () => {
    expect(repeatWindowFromEnv({})).toEqual(window);
    expect(repeatWindowFromEnv({ MEDIA_LIBRARY_REPEAT_DAYS: "3", MEDIA_LIBRARY_REPEAT_VIDEOS: "5" })).toEqual({ days: 3, videos: 5 });
  });

  it("a clip used 3 days ago is blocked; used 10 days ago in an old video is free once 20 newer videos exist", () => {
    const fresh = cand("a", [["j-new", 3]]);
    const old = cand("b", [["j-old", 10]]);
    // 20 newer distinct videos push j-old out of the last-20 window.
    const filler = Array.from({ length: 20 }, (_, i) => cand(`f${i}`, [[`j${i}`, 1 + i * 0.1]]));
    const w = usedInWindow([fresh, old, ...filler], window, NOW);
    expect(blockedByRepeatWindow(fresh, w)).toBe(true);
    expect(blockedByRepeatWindow(old, w)).toBe(false);
  });

  it("with fewer than 20 videos an old (>7d) use still blocks (last-20 rule)", () => {
    const old = cand("b", [["j-old", 10]]);
    const w = usedInWindow([old], window, NOW);
    expect(blockedByRepeatWindow(old, w)).toBe(true);
  });

  it("recent keys: within days OR among the N most recent", () => {
    const all = [cand("a", [["j1", 1]]), cand("b", [["j2", 30]]), cand("c", [["j3", 40]])];
    expect([...recentJobKeys(all, { days: 7, videos: 2 }, NOW)].sort()).toEqual(["j1", "j2"]);
    expect([...recentJobKeys(all, { days: 7, videos: 0 }, NOW)]).toEqual(["j1"]);
  });

  it("same checksum or external id under another asset id is a repeat; unused clip is free", () => {
    const used = cand("a", [["j", 1]], { checksumSha256: "same", externalId: "apify:tiktok:1" });
    const repost = cand("b", [], { checksumSha256: "same", externalId: "apify:tiktok:2" });
    const sameId = cand("c", [], { checksumSha256: "other", externalId: "apify:tiktok:1" });
    const free = cand("d", [], { checksumSha256: "zzz", externalId: "apify:tiktok:9" });
    const w = usedInWindow([used, repost, sameId, free], window, NOW);
    expect(blockedByRepeatWindow(repost, w)).toBe(true);
    expect(blockedByRepeatWindow(sameId, w)).toBe(true);
    expect(blockedByRepeatWindow(free, w)).toBe(false);
  });
});
