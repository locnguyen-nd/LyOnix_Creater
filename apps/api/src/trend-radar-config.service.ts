import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import { DEFAULT_TREND_ANALYSIS_BUDGET, TREND_CATEGORIES, sanitizeTrendThresholds, usageDay, type TrendThresholds } from "@lyonix/domain";
import { YAHOO_JAPAN_NEWS_SOURCE, YAHOO_TREND_CATEGORIES } from "@lyonix/providers";
import type { TrendRadarConfigResponse } from "@lyonix/contracts";
import { enabledNewsSourceIds } from "./news.service.js";
import { PrismaService } from "./prisma.service.js";

/**
 * VE2E-158: Trend Radar configuration (one DB row, id "default"). Sources start OFF.
 *
 * Yahoo!ニュース rule (owner decision 2026-10-10): the source may only operate once the operator has confirmed LyOnix's right to use
 * Yahoo! JAPAN RSS - signalled by the deployment config (`NEWS_SOURCES` contains `yahoo_jp`, the VE2E-96 mechanism). An admin switch is
 * NOT that confirmation: while it is missing, enabling the source is refused and runs report `rights_unconfirmed` (nothing is fetched).
 */

export type TrendRadarRuntimeConfig = {
  yahooEnabled: boolean;
  yahooRightsConfirmed: boolean;
  yahooCategories: string[];
  tiktokEnabled: boolean;
  tiktokAccountId: string | null;
  keywords: string[];
  hashtags: string[];
  categories: string[];
  windowHours: number;
  scheduleEnabled: boolean;
  intervalMinutes: number;
  thresholds: TrendThresholds;
  notifyMinScore: number;
  tiktokMaxQueries: number;
  tiktokResultsPerQuery: number;
  tiktokMinViews: number;
  analysisAccountId: string | null;
  autoAnalysisPerDay: number;
  analysisPerDay: number;
  updatedAt: Date;
};

export const TREND_CONFIG_LIMITS = {
  keywords: 30,
  hashtags: 30,
  wordChars: 40,
  windowHours: [6, 168],
  intervalMinutes: [15, 360],
  tiktokMaxQueries: [1, 10],
  tiktokResultsPerQuery: [5, 30],
  // Product decision (2026-10-10): at most 5 automatic Gemini analyses a day (Hot topics only); the rest is on click.
  autoAnalysisPerDay: [0, 5],
  analysisPerDay: [0, 100],
} as const;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

export const yahooRightsConfirmed = (env: Record<string, string | undefined> = process.env): boolean => enabledNewsSourceIds(env.NEWS_SOURCES).has("yahoo_jp");

type ConfigRow = Prisma.TrendRadarConfigGetPayload<Record<string, never>>;

const toRuntime = (row: ConfigRow): TrendRadarRuntimeConfig => ({
  yahooEnabled: row.yahooEnabled,
  yahooRightsConfirmed: yahooRightsConfirmed(),
  yahooCategories: strings(row.yahooCategories).filter((category) => (YAHOO_TREND_CATEGORIES as readonly string[]).includes(category)),
  tiktokEnabled: row.tiktokEnabled,
  tiktokAccountId: row.tiktokAccountId,
  keywords: strings(row.keywords),
  hashtags: strings(row.hashtags),
  categories: strings(row.categories),
  windowHours: row.windowHours,
  scheduleEnabled: row.scheduleEnabled,
  intervalMinutes: row.intervalMinutes,
  thresholds: sanitizeTrendThresholds(row.thresholds as Partial<TrendThresholds>),
  notifyMinScore: row.notifyMinScore,
  tiktokMaxQueries: row.tiktokMaxQueries,
  tiktokResultsPerQuery: row.tiktokResultsPerQuery,
  tiktokMinViews: row.tiktokMinViews,
  analysisAccountId: row.analysisAccountId,
  autoAnalysisPerDay: row.autoAnalysisPerDay,
  analysisPerDay: row.analysisPerDay,
  updatedAt: row.updatedAt,
});

export type ConfigUpdateOutcome = { ok: true; data: TrendRadarConfigResponse } | { ok: false; code: "VALIDATION_FAILED"; message: string };

@Injectable()
export class TrendRadarConfigService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async row(): Promise<ConfigRow> {
    return this.prisma.trendRadarConfig.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
  }

  async runtime(): Promise<TrendRadarRuntimeConfig> {
    return toRuntime(await this.row());
  }

  async view(): Promise<TrendRadarConfigResponse> {
    const config = await this.runtime();
    const [tiktokAccounts, analysisAccounts, usage] = await Promise.all([
      this.prisma.providerAccount.findMany({ where: { provider: "apify", deletedAt: null }, select: { id: true, name: true, status: true, enabled: true, scope: true }, orderBy: { name: "asc" } }),
      this.prisma.providerAccount.findMany({ where: { role: "content", deletedAt: null, status: "verified" }, select: { id: true, name: true, provider: true, model: true }, orderBy: { name: "asc" } }),
      this.prisma.trendAiUsage.findMany({ where: { day: usageDay(new Date()) } }),
    ]);
    const auto = usage.filter((row) => row.kind === "auto").reduce((sum, row) => sum + row.calls, 0);
    const manual = usage.filter((row) => row.kind === "manual").reduce((sum, row) => sum + row.calls, 0);
    return {
      yahooEnabled: config.yahooEnabled,
      yahooRightsConfirmed: config.yahooRightsConfirmed,
      yahooTermsUrl: YAHOO_JAPAN_NEWS_SOURCE.termsUrl,
      yahooCategories: config.yahooCategories,
      yahooAvailableCategories: [...YAHOO_TREND_CATEGORIES],
      tiktokEnabled: config.tiktokEnabled,
      tiktokAccountId: config.tiktokAccountId,
      tiktokAccounts: tiktokAccounts.map((account) => ({ id: account.id, name: account.name, status: account.status, enabled: account.enabled, scope: account.scope })),
      keywords: config.keywords,
      hashtags: config.hashtags,
      categories: config.categories,
      windowHours: config.windowHours,
      scheduleEnabled: config.scheduleEnabled,
      intervalMinutes: config.intervalMinutes,
      thresholds: config.thresholds,
      notifyMinScore: config.notifyMinScore,
      tiktokMaxQueries: config.tiktokMaxQueries,
      tiktokResultsPerQuery: config.tiktokResultsPerQuery,
      tiktokMinViews: config.tiktokMinViews,
      analysisAccountId: config.analysisAccountId,
      analysisAccounts,
      autoAnalysisPerDay: config.autoAnalysisPerDay,
      analysisPerDay: config.analysisPerDay,
      analysisUsageToday: { model: usage[0]?.model ?? null, auto, manual, failures: usage.reduce((sum, row) => sum + row.failures, 0) },
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  /** Validated partial update (admin). Unknown keys are ignored; any invalid value refuses the whole update. */
  async update(input: Record<string, unknown>, actorUserId: string): Promise<ConfigUpdateOutcome> {
    const invalid = (message: string): ConfigUpdateOutcome => ({ ok: false, code: "VALIDATION_FAILED", message });
    const data: Prisma.TrendRadarConfigUpdateInput = { updatedByUserId: actorUserId };
    const bool = (key: string): boolean | undefined | null => (input[key] === undefined ? undefined : typeof input[key] === "boolean" ? (input[key] as boolean) : null);
    const int = (key: string, [min, max]: readonly [number, number]): number | undefined | null => {
      if (input[key] === undefined) return undefined;
      const value = input[key];
      return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
    };
    const words = (key: string, limit: number): string[] | undefined | null => {
      if (input[key] === undefined) return undefined;
      if (!Array.isArray(input[key])) return null;
      const cleaned = [...new Set((input[key] as unknown[]).map((entry) => (typeof entry === "string" ? entry.normalize("NFKC").replace(/^#+/, "").trim() : "")).filter(Boolean))];
      if (cleaned.length > limit || cleaned.some((entry) => [...entry].length > TREND_CONFIG_LIMITS.wordChars)) return null;
      return cleaned;
    };

    for (const key of ["yahooEnabled", "tiktokEnabled", "scheduleEnabled"] as const) {
      const value = bool(key);
      if (value === null) return invalid(`${key} phải là true/false`);
      if (value !== undefined) data[key] = value;
    }
    if (data.yahooEnabled === true && !yahooRightsConfirmed()) {
      return invalid("Chưa xác nhận quyền sử dụng Yahoo! JAPAN RSS: nguồn này chỉ bật được sau khi bên vận hành xác nhận quyền (cấu hình triển khai), nút bật không thay cho xác nhận đó.");
    }
    for (const [key, range] of [
      ["windowHours", TREND_CONFIG_LIMITS.windowHours],
      ["intervalMinutes", TREND_CONFIG_LIMITS.intervalMinutes],
      ["tiktokMaxQueries", TREND_CONFIG_LIMITS.tiktokMaxQueries],
      ["tiktokResultsPerQuery", TREND_CONFIG_LIMITS.tiktokResultsPerQuery],
      ["autoAnalysisPerDay", TREND_CONFIG_LIMITS.autoAnalysisPerDay],
      ["analysisPerDay", TREND_CONFIG_LIMITS.analysisPerDay],
      ["notifyMinScore", [0, 100]],
      ["tiktokMinViews", [0, 1_000_000_000]],
    ] as const) {
      const value = int(key, range);
      if (value === null) return invalid(`${key} phải là số nguyên ${range[0]}..${range[1]}`);
      if (value !== undefined) (data as Record<string, unknown>)[key] = value;
    }
    const keywords = words("keywords", TREND_CONFIG_LIMITS.keywords);
    const hashtags = words("hashtags", TREND_CONFIG_LIMITS.hashtags);
    if (keywords === null) return invalid(`Tối đa ${TREND_CONFIG_LIMITS.keywords} từ khoá, mỗi từ ≤ ${TREND_CONFIG_LIMITS.wordChars} ký tự`);
    if (hashtags === null) return invalid(`Tối đa ${TREND_CONFIG_LIMITS.hashtags} hashtag, mỗi hashtag ≤ ${TREND_CONFIG_LIMITS.wordChars} ký tự`);
    if (keywords) data.keywords = keywords;
    if (hashtags) data.hashtags = hashtags;
    if (input.categories !== undefined) {
      const categories = strings(input.categories);
      if (!Array.isArray(input.categories) || categories.some((category) => !(TREND_CATEGORIES as readonly string[]).includes(category))) return invalid("Danh mục không hợp lệ");
      data.categories = [...new Set(categories)];
    }
    if (input.yahooCategories !== undefined) {
      const categories = strings(input.yahooCategories);
      if (!Array.isArray(input.yahooCategories) || categories.some((category) => !(YAHOO_TREND_CATEGORIES as readonly string[]).includes(category))) return invalid("Danh mục Yahoo không hợp lệ");
      data.yahooCategories = [...new Set(categories)];
    }
    if (input.thresholds !== undefined) {
      const raw = input.thresholds as Partial<TrendThresholds> | null;
      if (!raw || typeof raw !== "object") return invalid("thresholds không hợp lệ");
      const sanitized = sanitizeTrendThresholds(raw);
      if ((raw.hot !== undefined && raw.hot !== sanitized.hot) || (raw.rising !== undefined && raw.rising !== sanitized.rising) || (raw.review !== undefined && raw.review !== sanitized.review)) {
        return invalid("Ngưỡng phải là số nguyên 0..100 và giảm dần: Hot > Rising > Worth Reviewing");
      }
      data.thresholds = sanitized;
    }
    for (const [key, where] of [
      ["tiktokAccountId", { provider: "apify" }],
      ["analysisAccountId", { role: "content", status: "verified" as const }],
    ] as const) {
      if (input[key] === undefined) continue;
      if (input[key] === null) {
        (data as Record<string, unknown>)[key] = null;
        continue;
      }
      if (typeof input[key] !== "string") return invalid(`${key} không hợp lệ`);
      const found = await this.prisma.providerAccount.findFirst({ where: { id: input[key] as string, deletedAt: null, ...where }, select: { id: true } });
      if (!found) return invalid(key === "tiktokAccountId" ? "Không tìm thấy tài khoản Apify này" : "Không tìm thấy tài khoản content đã xác minh này");
      (data as Record<string, unknown>)[key] = found.id;
    }
    const current = await this.runtime();
    const auto = (data.autoAnalysisPerDay as number | undefined) ?? current.autoAnalysisPerDay;
    const total = (data.analysisPerDay as number | undefined) ?? current.analysisPerDay;
    if (auto > total) return invalid("Số lần phân tích tự động mỗi ngày không được lớn hơn tổng số lần mỗi ngày");
    await this.prisma.trendRadarConfig.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
    await this.prisma.trendRadarConfig.update({ where: { id: "default" }, data });
    return { ok: true, data: await this.view() };
  }

  /** Default budget of the AI analysis (also used before the config row exists). */
  static readonly defaultBudget = DEFAULT_TREND_ANALYSIS_BUDGET;
}
