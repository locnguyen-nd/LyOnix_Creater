import { describe, expect, it } from "vitest";
import { JAPAN_GEONAMES_ID, evaluateSocialCandidate, keywordOverlap, selectSocialCandidates, type SocialCandidateSignals, type SocialFilterContext } from "./social-candidate-filter.js";

// Fake values with the field shapes of the owner-job dataset (VE2E-50 diagnosis).
const base = (over: Partial<SocialCandidateSignals> = {}): SocialCandidateSignals => ({
  videoId: "7001", text: "東京 夜景 散歩", hashtags: ["東京", "夜景"], textLanguage: "ja", countryCode: JAPAN_GEONAMES_ID,
  isAd: false, isSponsored: false, widthPx: 720, heightPx: 1280, durationSeconds: 30, ...over,
});
const ctx = (over: Partial<SocialFilterContext> = {}): SocialFilterContext => ({ scriptLanguage: "ja", keyword: "東京 夜景", minDurationSeconds: 10, usedVideoIds: new Set(), ...over });
const reasons = (signals: SocialCandidateSignals, c = ctx()) => { const e = evaluateSocialCandidate(signals, c); return e.ok ? [] : e.reasons; };

describe("evaluateSocialCandidate (VE2E-51)", () => {
  it("accepts a Japanese, JP, vertical, long-enough clip and scores keyword overlap", () => {
    const e = evaluateSocialCandidate(base(), ctx());
    expect(e.ok).toBe(true);
    if (e.ok) { expect(e.overlap).toBe(1); expect(e.score).toBeGreaterThan(0.9); }
  });

  it("rejects foreign-language and non-JP clips for a ja script", () => {
    expect(reasons(base({ textLanguage: "en" }))).toContain("language_mismatch");
    expect(reasons(base({ countryCode: "6252001" }))).toContain("location_not_jp");
    expect(reasons(base({ textLanguage: "un", countryCode: null }))).toEqual(["language_unverified"]);
    expect(reasons(base({ textLanguage: "un", countryCode: "JP" }))).toEqual([]);
  });

  it("does not apply language/location rules to non-ja scripts", () => {
    expect(reasons(base({ textLanguage: "en", countryCode: "6252001" }), ctx({ scriptLanguage: "vi" }))).toEqual([]);
  });

  it("rejects ads, sponsored, template/greenscreen/CapCut captions and hashtags", () => {
    expect(reasons(base({ isAd: true }))).toEqual(["ad_or_sponsored"]);
    expect(reasons(base({ isSponsored: true }))).toEqual(["ad_or_sponsored"]);
    expect(reasons(base({ text: "Use this template in CapCut" }))).toEqual(["template_or_greenscreen"]);
    expect(reasons(base({ text: "夜景 greenscreen" }))).toEqual(["template_or_greenscreen"]);
    expect(reasons(base({ hashtags: ["#CapCut", "夜景"] }))).toEqual(["template_or_greenscreen"]);
    expect(reasons(base({ text: "このテンプレ使って" }))).toEqual(["template_or_greenscreen"]);
  });

  it("requires vertical orientation and a duration of at least the segment length", () => {
    expect(reasons(base({ widthPx: 1280, heightPx: 720 }))).toEqual(["not_vertical"]);
    expect(reasons(base({ widthPx: null, heightPx: null }))).toEqual([]);
    expect(reasons(base({ durationSeconds: 9 }))).toEqual(["too_short"]);
    expect(reasons(base({ durationSeconds: 10 }))).toEqual([]);
    expect(reasons(base({ durationSeconds: null }))).toEqual(["duration_unknown"]);
  });

  it("rejects a video an earlier segment already uses", () => {
    expect(reasons(base(), ctx({ usedVideoIds: new Set(["7001"]) }))).toEqual(["already_used"]);
  });
});

describe("keywordOverlap", () => {
  it("counts tokens in the caption or hashtags and partial CJK matches", () => {
    expect(keywordOverlap("東京 夜景", "今日の東京", ["夜景"])).toBe(1);
    expect(keywordOverlap("東京 夜景", "ラーメン", [])).toBe(0);
    expect(keywordOverlap("", "x", [])).toBe(0);
    expect(keywordOverlap("tokyo night", "TOKYO walk", [])).toBe(0.5);
  });
});

describe("selectSocialCandidates", () => {
  it("returns passed best-first, rejected with reasons and per-reason counts", () => {
    const items = [
      { ref: "a", signals: base({ videoId: "a", text: "無関係", hashtags: [] }) },
      { ref: "b", signals: base({ videoId: "b" }) },
      { ref: "c", signals: base({ videoId: "c", textLanguage: "en", isAd: true }) },
      { ref: "d", signals: base({ videoId: "d", durationSeconds: 3 }) },
    ];
    const selection = selectSocialCandidates(items, ctx());
    expect(selection.passed.map((p) => p.ref)).toEqual(["b", "a"]);
    expect(selection.rejected.map((r) => r.videoId)).toEqual(["c", "d"]);
    expect(selection.rejectCounts).toEqual({ language_mismatch: 1, ad_or_sponsored: 1, too_short: 1 });
  });
});
