import { describe, expect, it } from "vitest";
import { applySubjectToBrief, anchorKeywordToSubject, isOffTopic, subjectMatchScore, subjectProfileOf, subjectTierKeywords } from "./subject-filter.js";
import { rankMediaCandidates, decideMediaSelection, type SceneBrief } from "./media-ranking.js";
import type { MediaCandidate } from "./media-candidate.js";

const profile = subjectProfileOf({ subject: "Taro Yamada", keywords: { aliases: ["山田太郎", "Yamada"], mustExclude: ["tutorial"] } });
const brief: SceneBrief = { sceneId: "s1", beat: "hook", language: "ja", entities: ["goal"], action: [], setting: [], mood: [], exclusions: [], phrases: [], shotIntent: "", verticalOnly: true, targetDurationSeconds: 8 };
const cand = (id: string, text: string | null, author = "someone", heightPx = 1920): MediaCandidate =>
  ({ candidateId: id, source: "apify:tiktok", externalId: id, mediaType: "video", accessMethod: "api_download", previewUrl: null, embedUrl: null, importUrl: "u", durationSeconds: 10, widthPx: 1080, heightPx, attribution: { name: author, profileUrl: null, sourcePageUrl: null }, provenance: { query: "q", providerAccountId: "a", queriedAt: "t", catalogVersion: "v" }, rightsStatus: "owner_accepted_risk", capabilityEvidence: null, metadataScore: 0, descriptorText: text, visionFindings: null, relevanceScore: 0, moderationDecision: null, eligibility: { autoEligible: true } }) as unknown as MediaCandidate;

describe("subject filter (VE2E-89)", () => {
  it("anchors every tier keyword on the subject", () => {
    expect(anchorKeywordToSubject("ゴール 決勝", profile, "ja")).toBe("山田太郎 ゴール 決勝");
    expect(anchorKeywordToSubject("final goal", profile, "en")).toBe("Taro Yamada final goal");
    expect(anchorKeywordToSubject("Yamada final goal", profile, "en")).toBe("Yamada final goal");
  });
  it("builds subject-bound tiers, broad falls back to the subject, no subject = unchanged", () => {
    const tiers = subjectTierKeywords({ ja: ["決勝ゴール"], en: ["final goal"], broad_en: ["football stadium"] }, profile, (v) => /[぀-鿿]/.test(v));
    expect(tiers.map((t) => t.tier)).toEqual(["ja", "en", "broad"]);
    for (const t of tiers) expect(/Yamada|山田太郎|Taro Yamada/.test(t.keyword)).toBe(true);
    expect(subjectTierKeywords({ en: ["x y"] }, profile).find((t) => t.tier === "broad")?.keyword).toBe("Taro Yamada");
    expect(subjectTierKeywords({ en: ["tokyo"] }, subjectProfileOf({}))).toEqual([{ tier: "en", keyword: "tokyo" }]);
  });
  it("scores metadata: caption/hashtag 1, author 0.5, none 0", () => {
    expect(subjectMatchScore(profile, { text: "great #TaroYamada goal" })).toBe(1);
    expect(subjectMatchScore(profile, { text: "x", author: "yamada_fans" })).toBe(0.5);
    expect(subjectMatchScore(profile, { text: "random" })).toBe(0);
    expect(isOffTopic(profile, "Football TUTORIAL for kids")).toBe(true);
  });
  it("ranks subject-matching clips first, drops mustExclude clips, never throws", () => {
    const b = applySubjectToBrief(brief, profile, { priority: 1 });
    expect(b.entities).toContain("山田太郎");
    const ranked = rankMediaCandidates([cand("a", "random clip"), cand("b", "#yamada amazing goal"), cand("c", "yamada tutorial")], b);
    expect(ranked[0]!.candidate.externalId).toBe("b");
    expect(ranked.find((r) => r.candidate.externalId === "c")!.combinedScore).toBe(0);
    expect(decideMediaSelection(ranked, { relevanceThreshold: 0 }).decision).toBe("auto_select");
  });
  it("only high-priority segments feed the subject to vision entities; coherence is a light bonus", () => {
    expect(applySubjectToBrief(brief, profile, { priority: 3 }).entities).toEqual(["goal"]);
    const b = applySubjectToBrief({ ...brief, entities: ["zzz"] }, profile, { priority: 1, preferredAuthors: ["Fan1"] });
    const ranked = rankMediaCandidates([cand("x", "yamada goal", "Other", 600), cand("y", "yamada goal", "fan1", 600)], b);
    expect(ranked[0]!.candidate.externalId).toBe("y");
    expect(ranked[0]!.combinedScore - ranked[1]!.combinedScore).toBeLessThan(0.05);
  });
});
