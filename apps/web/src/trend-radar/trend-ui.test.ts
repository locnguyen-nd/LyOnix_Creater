import { describe, expect, it } from "vitest";
import type { TrendClusterDetailResponse, TrendItemResponse } from "@lyonix/contracts";
import { TOPIC_MAX_CHARS, angleChoice, compactNumber, composeTrendTopic, configPatch, createVideoLink, EMPTY_FILTERS, filtersQuery, linesOf, metricEntries, timeAgo, type TrendConfigDraft } from "./trend-ui";

const item = (over: Partial<TrendItemResponse> = {}): TrendItemResponse => ({
  id: "i1",
  provider: "yahoo_news",
  sourceId: "y1",
  url: "https://news.yahoo.co.jp/articles/abc",
  title: "架空投手が7回1失点の快投",
  author: null,
  publisher: "スポーツ報知",
  excerpt: null,
  thumbnailUrl: null,
  hashtags: [],
  category: "sports",
  publishedAt: "2026-10-10T01:00:00.000Z",
  collectedAt: "2026-10-10T02:00:00.000Z",
  metrics: null,
  completeness: "headline_only",
  ...over,
});

const cluster = (over: Partial<TrendClusterDetailResponse> = {}): TrendClusterDetailResponse => ({
  id: "c1",
  title: "架空投手が7回1失点の快投",
  category: "sports",
  status: "new",
  saved: false,
  score: 64,
  band: "rising",
  components: [],
  notes: [],
  itemCount: 2,
  providers: ["yahoo_news", "tiktok"],
  firstSeenAt: "2026-10-10T01:00:00.000Z",
  lastSeenAt: "2026-10-10T02:00:00.000Z",
  latestPublishedAt: "2026-10-10T01:00:00.000Z",
  hashtags: [],
  metrics: null,
  summaryVi: null,
  analysisStatus: "done",
  assignments: [],
  productionRefs: [],
  topItems: [],
  items: [item(), item({ id: "i2", provider: "tiktok", url: "https://www.tiktok.com/@fan/video/7400000000000000001", publisher: null, author: "fan" }), item({ id: "i3", url: "https://example.jp/3", publisher: "第三" })],
  analysis: {
    titleJa: "架空投手、7回1失点",
    titleVi: "Tay ném hư cấu",
    summaryVi: "",
    summaryJa: "",
    mainTopic: "",
    category: "sports",
    whyInteresting: "",
    facts: [],
    angles: [{ title: "Tóm tắt 30 giây", approach: "kể lại trận đấu" }, { title: "Con số", approach: "3 con số" }, { title: "Phản ứng fan", approach: "bình luận" }],
    hooksJa: [],
    suggestedTitleJa: "",
    captionJa: "",
    hashtags: [],
    reliability: { level: "medium", reason: "" },
    warnings: [],
    dataNote: "",
  },
  analysisError: null,
  analysisModel: "gemini-2.5-flash",
  analyzedAt: null,
  history: [],
  ...over,
});

describe("VE2E-158 trend-ui", () => {
  it("metrics: only the numbers a source returned - a missing one is never shown as 0", () => {
    expect(metricEntries(null)).toEqual([]);
    expect(metricEntries({ views: null, likes: null, comments: null, shares: null, measuredAt: "2026-10-10T00:00:00Z" })).toEqual([]);
    expect(metricEntries({ views: 125_000, likes: 0, comments: null, shares: 1_500, measuredAt: "2026-10-10T00:00:00Z" })).toEqual([
      { key: "views", value: "125.0K" },
      { key: "likes", value: "0" },
      { key: "shares", value: "1.5K" },
    ]);
    expect(compactNumber(2_500_000)).toBe("2.5M");
    expect(compactNumber(undefined)).toBeNull();
  });

  it("filters become the list query (empty ones left out, keyword trimmed, paging always sent)", () => {
    expect(filtersQuery(EMPTY_FILTERS, { limit: 24, offset: 0 })).toBe("sinceHours=48&limit=24&offset=0");
    const query = new URLSearchParams(filtersQuery({ ...EMPTY_FILTERS, provider: "tiktok", band: "hot", q: "  大谷 ", saved: true, sinceHours: "", minScore: "60", assigneeId: "u1" }, { limit: 24, offset: 48 }));
    expect(Object.fromEntries(query)).toEqual({ provider: "tiktok", band: "hot", minScore: "60", assigneeId: "u1", q: "大谷", saved: "1", limit: "24", offset: "48" });
  });

  it("several people on one topic: the angles colleagues took are marked and a free one is suggested", () => {
    const shared = cluster({ assignments: [
      { userId: "u-a", displayName: "An", angleIndex: 0, angleTitle: "Tóm tắt 30 giây", createdAt: "" },
      { userId: "u-me", displayName: "Me", angleIndex: 2, angleTitle: null, createdAt: "" },
    ] });
    const choice = angleChoice(shared, "u-me");
    expect([...choice.taken]).toEqual([[0, "An"]]); // my own pick is not "taken"
    expect(choice.suggested).toBe(1);
    expect(angleChoice(cluster({ analysis: null }), "u-me").suggested).toBeNull(); // not analysed: no angle to suggest
  });

  it("the topic for the create-video page: headline, chosen angle, then the named sources with links; never longer than the field", () => {
    const topic = composeTrendTopic(cluster(), cluster().analysis!.angles[1]!);
    expect(topic.split("\n\n")).toEqual([
      "架空投手、7回1失点",
      "Angle: Con số - 3 con số",
      "Source: スポーツ報知 - https://news.yahoo.co.jp/articles/abc",
      "Source: fan - https://www.tiktok.com/@fan/video/7400000000000000001",
    ]);
    expect(composeTrendTopic(cluster({ analysis: null }), null)).toMatch(/^架空投手が7回1失点の快投\n\nSource: /);
    const long = composeTrendTopic(cluster(), { title: "長".repeat(200), approach: "い".repeat(300) });
    expect([...long].length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
    expect(long).toContain("Source: スポーツ報知 - https://news.yahoo.co.jp/articles/abc"); // the sources are kept, the angle is cut
    expect(long).toContain("…");
  });

  it("create-video link carries the topic and the angle", () => {
    expect(createVideoLink("c1", 2)).toBe("/jobs/new?entry=auto&trend=c1&angle=2");
    expect(createVideoLink("c1", null)).toBe("/jobs/new?entry=auto&trend=c1");
  });

  it("settings: word lists from text, and only editable fields are sent back", () => {
    expect(linesOf("大谷\n#WBC, 大谷\n\n  新幹線  、 #ラーメン")).toEqual(["大谷", "WBC", "新幹線", "ラーメン"]);
    const draft = {
      yahooEnabled: false, yahooRightsConfirmed: false, yahooTermsUrl: "https://news.yahoo.co.jp/rss", yahooCategories: ["sports"], yahooAvailableCategories: ["japan", "sports"],
      tiktokEnabled: true, tiktokAccountId: "acc-1", tiktokAccounts: [{ id: "acc-1", name: "Apify", status: "verified", enabled: true, scope: "organization" }],
      keywords: [], hashtags: [], categories: ["sports"], windowHours: 48, scheduleEnabled: true, intervalMinutes: 60, thresholds: { hot: 80, rising: 60, review: 40 }, notifyMinScore: 60,
      tiktokMaxQueries: 3, tiktokResultsPerQuery: 20, tiktokMinViews: 0, analysisAccountId: null, analysisAccounts: [], autoAnalysisPerDay: 5, analysisPerDay: 15,
      analysisUsageToday: { model: null, auto: 0, manual: 0, failures: 0 }, updatedAt: "", keywordsText: "大谷\n大谷", hashtagsText: "#WBC",
    } satisfies TrendConfigDraft;
    const patch = configPatch(draft);
    expect(patch).toMatchObject({ keywords: ["大谷"], hashtags: ["WBC"], tiktokAccountId: "acc-1", yahooEnabled: false });
    for (const serverOnly of ["yahooRightsConfirmed", "yahooTermsUrl", "tiktokAccounts", "analysisAccounts", "analysisUsageToday", "updatedAt", "keywordsText"]) expect(patch).not.toHaveProperty(serverOnly);
  });

  it("time ago", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(timeAgo(null, now)).toBeNull();
    expect(timeAgo("2026-10-10T11:35:00Z", now)).toEqual({ value: 25, unit: "minute" });
    expect(timeAgo("2026-10-10T03:00:00Z", now)).toEqual({ value: 9, unit: "hour" });
    expect(timeAgo("2026-10-06T12:00:00Z", now)).toEqual({ value: 4, unit: "day" });
  });
});
