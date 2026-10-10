import { describe, expect, it } from "vitest";
import { buildTrendAnalysisPrompt, fakeTrendAnalysis, parseTrendAnalysis, TREND_ANALYSIS_SCHEMA } from "./trend-analysis.js";

const source = { provider: "yahoo_news", title: "大谷翔平が40号ホームラン", url: "https://news.yahoo.co.jp/articles/1", publisher: "スポーツ報知", author: null, publishedAt: "2026-10-10T11:00:00Z", excerpt: null, hashtags: [], metrics: null, completeness: "headline_only" as const };

const valid = {
  titleJa: "大谷翔平が40号",
  titleVi: "Ohtani đạt cú home run thứ 40",
  summaryVi: "Theo tiêu đề của Sports Hochi, Ohtani đạt cú home run thứ 40.",
  summaryJa: "スポーツ報知の見出しによると、大谷翔平が40号ホームラン。",
  mainTopic: "大谷翔平 40号",
  category: "sports",
  whyInteresting: "Cột mốc dễ hiểu.",
  facts: ["大谷翔平が40号ホームラン (スポーツ報知)"],
  angles: [
    { title: "A", approach: "a" },
    { title: "B", approach: "b" },
    { title: "C", approach: "c" },
  ],
  hooksJa: ["1", "2", "3"],
  suggestedTitleJa: "40号",
  captionJa: "大谷 40号",
  hashtags: ["#大谷翔平", "MLB"],
  reliability: { level: "medium", reason: "Chỉ có tiêu đề." },
  warnings: [],
  dataNote: "Chỉ có tiêu đề, chưa đọc bài gốc.",
};

describe("trend analysis prompt / parser", () => {
  it("the prompt quotes only the sources, says article pages were not read, and forbids invented facts / growth claims", () => {
    const prompt = buildTrendAnalysisPrompt({ sources: [source], scoreReasons: ["Xuất hiện ở 2 nguồn"] });
    expect(prompt).toContain("Article pages were NOT read");
    expect(prompt).toContain("excerpt: (none - only the headline is available)");
    expect(prompt).toContain("Do not add events, numbers, names, quotes or causes");
    expect(prompt).toContain("never call the topic viral or rising from a single view count");
    expect(prompt).toContain("https://news.yahoo.co.jp/articles/1");
    expect(TREND_ANALYSIS_SCHEMA.required).toContain("facts");
  });

  it("accepts a complete answer (hashtags without '#'), rejects a partial one", () => {
    const parsed = parseTrendAnalysis(valid);
    expect(parsed).toMatchObject({ category: "sports", hashtags: ["大谷翔平", "MLB"], reliability: { level: "medium" } });
    expect(parseTrendAnalysis({ ...valid, angles: valid.angles.slice(0, 2) })).toBeNull();
    expect(parseTrendAnalysis({ ...valid, reliability: { level: "certain" } })).toBeNull();
    expect(parseTrendAnalysis({ ...valid, category: "unknown" })?.category).toBe("other");
    expect(parseTrendAnalysis("nope")).toBeNull();
  });

  it("a fake (test) account gets a clearly labelled sample, never presented as AI", () => {
    const fake = fakeTrendAnalysis([source]);
    expect(fake.titleVi.startsWith("[Thử nghiệm]")).toBe(true);
    expect(parseTrendAnalysis(fake)).not.toBeNull();
  });
});
