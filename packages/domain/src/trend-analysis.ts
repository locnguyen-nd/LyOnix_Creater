/**
 * VE2E-158 Trend Radar - AI analysis of one topic (ONE model call per analysis): the prompt, the JSON schema and the strict parser.
 *
 * The model only ever sees what LyOnix really has (titles, feed excerpts, publishers, links, real metrics) and is told so: it must keep
 * source FACTS apart from its creative SUGGESTIONS, never invent events / numbers / quotes, and say how reliable / sensitive the topic is.
 * When the sources are headline-only the analysis says so (`dataCompleteness`). Pure, browser-safe.
 */

import type { TrendCategory, TrendDataCompleteness, TrendMetrics } from "./trend-radar.js";
import { TREND_CATEGORIES } from "./trend-radar.js";

export type TrendAnalysisSource = {
  provider: string;
  title: string;
  url: string;
  publisher: string | null;
  author: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  hashtags: readonly string[];
  metrics: TrendMetrics | null;
  completeness: TrendDataCompleteness;
};

export type TrendAngle = { title: string; approach: string };

export type TrendAnalysis = {
  titleJa: string;
  titleVi: string;
  summaryVi: string;
  summaryJa: string;
  mainTopic: string;
  category: TrendCategory;
  whyInteresting: string;
  /** Statements taken from the sources only (each must be traceable to a title / excerpt / metric given). */
  facts: string[];
  /** Three different 30-60 s video angles (creative suggestions). */
  angles: TrendAngle[];
  hooksJa: string[];
  suggestedTitleJa: string;
  captionJa: string;
  hashtags: string[];
  reliability: { level: "high" | "medium" | "low"; reason: string };
  warnings: string[];
  /** What the analysis was based on, in plain words (e.g. "chỉ có tiêu đề, chưa đọc bài gốc"). */
  dataNote: string;
};

export const TREND_ANALYSIS_PROMPT_VERSION = "trend-analysis.v1";

const describeMetrics = (m: TrendMetrics | null): string => {
  if (!m) return "no engagement metrics";
  const parts = [m.views !== null ? `views ${m.views}` : "", m.likes !== null ? `likes ${m.likes}` : "", m.comments !== null ? `comments ${m.comments}` : "", m.shares !== null ? `shares ${m.shares}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(", ")} (measured ${m.measuredAt}, ONE measurement - not a growth trend)` : "no engagement metrics";
};

/** The single prompt of one analysis. Sources are quoted as data; the instructions forbid inventing anything beyond them. */
export function buildTrendAnalysisPrompt(input: { sources: readonly TrendAnalysisSource[]; scoreReasons: readonly string[] }): string {
  const lines = input.sources.slice(0, 8).map((source, index) => {
    const meta = [source.publisher ? `publisher: ${source.publisher}` : "", source.author ? `author: ${source.author}` : "", source.publishedAt ? `published: ${source.publishedAt}` : "", `data: ${source.completeness}`].filter(Boolean).join("; ");
    return [`[${index + 1}] (${source.provider}) ${source.title}`, `    url: ${source.url}`, `    ${meta}`, source.excerpt ? `    excerpt: ${source.excerpt}` : "    excerpt: (none - only the headline is available)", source.hashtags.length ? `    hashtags: ${source.hashtags.slice(0, 12).map((tag) => `#${tag}`).join(" ")}` : "", `    metrics: ${describeMetrics(source.metrics)}`].filter(Boolean).join("\n");
  });
  return [
    "You help a Japanese short-video (TikTok, 30-60 s) team decide whether and how to cover a trending topic.",
    "SOURCES below are everything we have. Article pages were NOT read: when a source has no excerpt, only its headline is known.",
    "Rules:",
    "- `facts` may only contain statements present in the SOURCES (headline, excerpt, publisher, time, metrics). Do not add events, numbers, names, quotes or causes that are not in them.",
    "- Everything else (angles, hooks, titles, caption, hashtags, whyInteresting) is a creative SUGGESTION and must not state new facts as true.",
    "- If the sources are headline-only or a single source, say so in `dataNote` and lower `reliability`.",
    "- Add a warning for unverified claims, rumours, accidents / deaths / crimes, health or legal topics, minors, or anything that needs fact-checking before publishing.",
    "- One metric measurement is not growth: never call the topic viral or rising from a single view count.",
    "- titleJa / summaryJa / hooksJa / suggestedTitleJa / captionJa in natural Japanese; titleVi / summaryVi / whyInteresting / approach / reliability.reason / warnings / dataNote in Vietnamese.",
    `- category: one of ${TREND_CATEGORIES.join(", ")}. Exactly 3 angles and 3 hooks, 3-8 hashtags without '#'.`,
    "",
    "Why LyOnix ranked it (computed, not for you to change):",
    ...input.scoreReasons.slice(0, 8).map((reason) => `- ${reason}`),
    "",
    "Answer with ONLY one JSON object (no markdown) with exactly these keys:",
    TREND_ANALYSIS_JSON_SHAPE,
    "",
    "SOURCES:",
    ...lines,
  ].join("\n");
}

/** The answer's shape, spelled out in the prompt (the call sends no response schema: one request, nothing for the provider to reject). */
export const TREND_ANALYSIS_JSON_SHAPE = JSON.stringify({
  titleJa: "string",
  titleVi: "string",
  summaryVi: "string",
  summaryJa: "string",
  mainTopic: "string",
  category: "one of the categories above",
  whyInteresting: "string",
  facts: ["string (from SOURCES only)"],
  angles: [{ title: "string", approach: "string" }],
  hooksJa: ["string", "string", "string"],
  suggestedTitleJa: "string",
  captionJa: "string",
  hashtags: ["string"],
  reliability: { level: "high | medium | low", reason: "string" },
  warnings: ["string"],
  dataNote: "string",
});

const str = { type: "string" } as const;
const strArray = { type: "array", items: str } as const;

/** JSON schema of the answer (structured output). */
export const TREND_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    titleJa: str,
    titleVi: str,
    summaryVi: str,
    summaryJa: str,
    mainTopic: str,
    category: { type: "string", enum: [...TREND_CATEGORIES] },
    whyInteresting: str,
    facts: strArray,
    angles: { type: "array", items: { type: "object", properties: { title: str, approach: str }, required: ["title", "approach"] } },
    hooksJa: strArray,
    suggestedTitleJa: str,
    captionJa: str,
    hashtags: strArray,
    reliability: { type: "object", properties: { level: { type: "string", enum: ["high", "medium", "low"] }, reason: str }, required: ["level", "reason"] },
    warnings: strArray,
    dataNote: str,
  },
  required: ["titleJa", "titleVi", "summaryVi", "summaryJa", "mainTopic", "category", "whyInteresting", "facts", "angles", "hooksJa", "suggestedTitleJa", "captionJa", "hashtags", "reliability", "warnings", "dataNote"],
} as const;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const texts = (value: unknown, max: number, count: number): string[] => (Array.isArray(value) ? value.map((entry) => text(entry, max)).filter(Boolean).slice(0, count) : []);

/** Strict reader of the model's answer: null when a required part is missing (the caller records a failed analysis, never a half one). */
export function parseTrendAnalysis(raw: unknown): TrendAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const angles = Array.isArray(value.angles)
    ? value.angles
        .map((angle) => (angle && typeof angle === "object" ? { title: text((angle as Record<string, unknown>).title, 120), approach: text((angle as Record<string, unknown>).approach, 600) } : null))
        .filter((angle): angle is TrendAngle => Boolean(angle?.title && angle.approach))
        .slice(0, 3)
    : [];
  const reliability = value.reliability && typeof value.reliability === "object" ? (value.reliability as Record<string, unknown>) : {};
  const level = reliability.level === "high" || reliability.level === "medium" || reliability.level === "low" ? reliability.level : null;
  const category = (TREND_CATEGORIES as readonly string[]).includes(value.category as string) ? (value.category as TrendCategory) : "other";
  const parsed: TrendAnalysis = {
    titleJa: text(value.titleJa, 200),
    titleVi: text(value.titleVi, 200),
    summaryVi: text(value.summaryVi, 1200),
    summaryJa: text(value.summaryJa, 1200),
    mainTopic: text(value.mainTopic, 120),
    category,
    whyInteresting: text(value.whyInteresting, 800),
    facts: texts(value.facts, 300, 10),
    angles,
    hooksJa: texts(value.hooksJa, 160, 3),
    suggestedTitleJa: text(value.suggestedTitleJa, 120),
    captionJa: text(value.captionJa, 600),
    hashtags: texts(value.hashtags, 60, 8).map((tag) => tag.replace(/^#+/, "")),
    reliability: { level: level ?? "low", reason: text(reliability.reason, 400) },
    warnings: texts(value.warnings, 300, 8),
    dataNote: text(value.dataNote, 400),
  };
  if (!parsed.titleJa || !parsed.titleVi || !parsed.summaryVi || angles.length < 3 || parsed.hooksJa.length < 3 || !level) return null;
  return parsed;
}

/** Deterministic analysis of a fake (dev / test) content account: no model call, clearly labelled. */
export function fakeTrendAnalysis(sources: readonly TrendAnalysisSource[]): TrendAnalysis {
  const title = sources[0]?.title ?? "トピック";
  return {
    titleJa: title,
    titleVi: `[Thử nghiệm] ${title}`,
    summaryVi: "Bản phân tích mẫu của tài khoản content thử nghiệm (không gọi AI).",
    summaryJa: "テスト用アカウントによる見本の分析です。",
    mainTopic: title.slice(0, 40),
    category: "other",
    whyInteresting: "Dữ liệu mẫu.",
    facts: sources.slice(0, 3).map((source) => source.title),
    angles: [
      { title: "Tóm tắt nhanh", approach: "Tóm tắt điều đã biết từ nguồn trong 30 giây." },
      { title: "Bối cảnh", approach: "Giải thích bối cảnh, nói rõ phần nào chưa được xác nhận." },
      { title: "Hỏi người xem", approach: "Đặt câu hỏi mở cho người xem bình luận." },
    ],
    hooksJa: ["今話題のニュース", "知っていましたか？", "30秒で解説"],
    suggestedTitleJa: title.slice(0, 40),
    captionJa: title,
    hashtags: ["ニュース"],
    reliability: { level: "low", reason: "Phân tích mẫu, không dựa trên AI." },
    warnings: ["Phân tích mẫu: không dùng để xuất bản."],
    dataNote: "Tài khoản content thử nghiệm.",
  };
}
