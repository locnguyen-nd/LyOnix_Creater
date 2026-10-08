import { describe, expect, it } from "vitest";
import { selectSocialSearchItems, type SocialSearchCandidate } from "./social-search-select.js";

const item = (over: Partial<SocialSearchCandidate>): SocialSearchCandidate => ({
  url: "https://www.youtube.com/shorts/aaaaaaaaaaa", externalId: "aaaaaaaaaaa", mediaType: "video", title: "メッシ 最後の試合", description: null,
  uploader: null, channel: "sports jp", durationSeconds: 40, width: null, height: null, viewCount: 1000, tags: [], ...over,
});
const ctx = { mediaType: "video" as const, usedIds: new Set<string>(), minDurationSeconds: 8, maxDurationSeconds: 180, subjectAliases: ["メッシ", "Messi"], keywords: ["メッシ 引退"] };

describe("selectSocialSearchItems (VE2E-147/148)", () => {
  it("keeps on-subject Shorts and ranks subject hits, keyword overlap and Shorts URLs first", () => {
    const out = selectSocialSearchItems(
      [
        item({ externalId: "a1", url: "https://www.youtube.com/watch?v=a1", title: "Messi goal", viewCount: 10 }),
        item({ externalId: "a2", title: "メッシ Messi 引退 会見", tags: ["shorts"] }),
      ],
      ctx,
    );
    expect(out.passed.map((p) => p.item.externalId)).toEqual(["a2", "a1"]);
    expect(out.passed[0]!.subjectHits).toBe(2);
  });

  it("rejects used, wrong type, too short / too long, landscape video and off-subject results", () => {
    const out = selectSocialSearchItems(
      [
        item({ externalId: "used" }),
        item({ externalId: "img", mediaType: "image" }),
        item({ externalId: "short", durationSeconds: 5 }),
        item({ externalId: "long", durationSeconds: 600 }),
        item({ externalId: "wide", width: 1920, height: 1080 }),
        item({ externalId: "off", title: "教会の礼拝", channel: "church" }),
        item({ externalId: null }),
      ],
      { ...ctx, usedIds: new Set(["used"]) },
    );
    expect(out.passed).toEqual([]);
    expect(out.rejectCounts).toEqual({ used: 1, wrong_type: 1, too_short: 1, too_long: 1, landscape: 1, off_subject: 1, no_id: 1 });
  });

  it("without a named subject every result passes the gate; unknown duration is not rejected", () => {
    const out = selectSocialSearchItems([item({ externalId: "x", title: "夜景", durationSeconds: null })], { ...ctx, subjectAliases: [] });
    expect(out.passed).toHaveLength(1);
  });

  it("images: landscape is only a penalty, NFKC-insensitive matching", () => {
    const out = selectSocialSearchItems(
      [item({ externalId: "p1", mediaType: "image", title: "ＭＥＳＳＩ wallpaper", width: 1600, height: 900 }), item({ externalId: "p2", mediaType: "image", title: "messi portrait", width: 800, height: 1200 })],
      { ...ctx, mediaType: "image" },
    );
    expect(out.passed.map((p) => p.item.externalId)).toEqual(["p2", "p1"]);
  });
});
