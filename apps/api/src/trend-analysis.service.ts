import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import { analysisAllowed, buildTrendAnalysisPrompt, fakeTrendAnalysis, parseTrendAnalysis, usageDay, type TrendAnalysis, type TrendAnalysisSource, type TrendMetrics } from "@lyonix/domain";
import { ProviderError, generateContentOnce, isLiveContentKind, type LiveContentKind } from "@lyonix/providers";
import { PrismaService } from "./prisma.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { TrendRadarConfigService } from "./trend-radar-config.service.js";

/**
 * VE2E-158: AI analysis of one Trend Radar topic through the EXISTING content provider accounts (Gemini adapter; no new key / provider).
 *
 *  - ONE model call per analysis (`generateContentOnce`, JSON mode, the answer shape spelled out in the prompt - no response schema for the
 *    provider to reject), parsed strictly; a partial answer is a failed analysis, never stored as if complete.
 *  - Budget (owner decision 2026-10-10): `auto` (Hot topics, by the job) at most `autoAnalysisPerDay` (5) per UTC day, every call at most
 *    `analysisPerDay` per day and model - LyOnix's own cap; the provider's real quota is only learnt from its answers. A call is counted
 *    BEFORE it is made, so concurrent requests cannot overshoot.
 *  - A quota / rate-limit answer benches that (account, model) with the provider's retry time (VE2E-56 cooldown); the topic keeps its
 *    collected data and says when to retry. Nothing here can fail a collection run.
 */

export type TrendAnalysisOutcome = { status: "done" | "failed" | "quota" | "limit" | "not_configured"; message: string | null; retryAt: string | null };

type Account = { id: string; name: string; provider: string; model: string; preferredModels: string[]; encryptedSecret: string; isFake: boolean };

const metricsOf = (value: unknown): TrendMetrics | null => (value && typeof value === "object" ? (value as TrendMetrics) : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

@Injectable()
export class TrendAnalysisService {
  private readonly logger = new Logger(TrendAnalysisService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TrendRadarConfigService) private readonly config: TrendRadarConfigService,
    @Inject(ProviderAccountsService) private readonly accounts: ProviderAccountsService,
  ) {}

  /** The configured content account, else the first verified organization-wide one (never someone's personal account by default). */
  async account(): Promise<Account | null> {
    const config = await this.config.runtime();
    const select = { id: true, name: true, provider: true, model: true, preferredModels: true, encryptedSecret: true, isFake: true } as const;
    if (config.analysisAccountId) {
      return this.prisma.providerAccount.findFirst({ where: { id: config.analysisAccountId, role: "content", status: "verified", deletedAt: null }, select });
    }
    return this.prisma.providerAccount.findFirst({ where: { role: "content", status: "verified", scope: "organization", deletedAt: null }, orderBy: { createdAt: "asc" }, select });
  }

  private async usedToday(day: string, model: string): Promise<{ auto: number; total: number }> {
    const rows = await this.prisma.trendAiUsage.findMany({ where: { day, model } });
    return { auto: rows.filter((row) => row.kind === "auto").reduce((sum, row) => sum + row.calls, 0), total: rows.reduce((sum, row) => sum + row.calls, 0) };
  }

  private async count(day: string, model: string, kind: "auto" | "manual", field: "calls" | "failures"): Promise<void> {
    await this.prisma.trendAiUsage.upsert({ where: { day_model_kind: { day, model, kind } }, create: { day, model, kind, [field]: 1 }, update: { [field]: { increment: 1 } } });
  }

  private async record(clusterId: string, data: Prisma.TrendClusterUpdateInput): Promise<void> {
    await this.prisma.trendCluster.update({ where: { id: clusterId }, data });
  }

  async analyze(clusterId: string, kind: "auto" | "manual", now: Date = new Date()): Promise<TrendAnalysisOutcome> {
    const cluster = await this.prisma.trendCluster.findUnique({ where: { id: clusterId }, include: { items: { orderBy: { collectedAt: "asc" }, take: 8 } } });
    if (!cluster) return { status: "failed", message: "Không tìm thấy chủ đề", retryAt: null };
    const account = await this.account();
    if (!account) {
      const message = "Chưa có tài khoản content để phân tích: chọn một tài khoản trong cấu hình Trend Radar (hoặc thêm một tài khoản dùng chung cho tổ chức).";
      await this.record(clusterId, { analysisStatus: "not_configured", analysisError: message });
      return { status: "not_configured", message, retryAt: null };
    }
    const model = account.preferredModels[0] ?? account.model;
    if (!account.isFake) {
      const availability = await this.accounts.getModelAvailability(account.id, model, now);
      if (!availability.available) {
        const retryAt = availability.retryAt?.toISOString() ?? null;
        const message = `Model ${model} đang bị giới hạn quota${retryAt ? `, thử lại sau ${retryAt}` : ""}. Dữ liệu đã thu thập vẫn xem được.`;
        await this.record(clusterId, { analysisStatus: "quota", analysisError: message });
        return { status: "quota", message, retryAt };
      }
    }
    const config = await this.config.runtime();
    const day = usageDay(now);
    const allowed = analysisAllowed(kind, await this.usedToday(day, model), { autoPerDay: config.autoAnalysisPerDay, totalPerDay: config.analysisPerDay });
    if (!allowed.ok) {
      const message = allowed.reason === "auto_limit" ? `Đã đủ ${config.autoAnalysisPerDay} lần phân tích tự động hôm nay; bấm "Phân tích" để phân tích thủ công.` : `Đã dùng hết ${config.analysisPerDay} lần phân tích hôm nay cho model ${model}; thử lại vào ngày mai (UTC).`;
      if (cluster.analysisStatus !== "done") await this.record(clusterId, { analysisStatus: "limit", analysisError: message });
      return { status: "limit", message, retryAt: null };
    }
    await this.count(day, model, kind, "calls");

    const sources: TrendAnalysisSource[] = cluster.items.map((item) => ({
      provider: item.provider,
      title: item.title,
      url: item.url,
      publisher: item.publisher,
      author: item.author,
      publishedAt: item.publishedAt?.toISOString() ?? null,
      excerpt: item.excerpt,
      hashtags: strings(item.hashtags),
      metrics: metricsOf(item.metrics),
      completeness: item.completeness as TrendAnalysisSource["completeness"],
    }));
    const breakdown = cluster.scoreBreakdown as { components?: Array<{ reason: string; points: number }> } | null;
    const prompt = buildTrendAnalysisPrompt({ sources, scoreReasons: (breakdown?.components ?? []).filter((component) => component.points !== 0).map((component) => component.reason) });

    let analysis: TrendAnalysis | null = null;
    try {
      if (account.isFake || account.provider === "fake") analysis = fakeTrendAnalysis(sources);
      else {
        if (!isLiveContentKind(account.provider)) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `Provider ${account.provider} không hỗ trợ phân tích`, false);
        const result = await generateContentOnce<unknown>(account.provider as LiveContentKind, decryptSecret(account.encryptedSecret), model, prompt);
        analysis = parseTrendAnalysis(result.output);
      }
    } catch (error) {
      await this.count(day, model, kind, "failures");
      if (error instanceof ProviderError && (error.code === "PROVIDER_QUOTA_EXHAUSTED" || error.code === "PROVIDER_RATE_LIMITED")) {
        const retryAt = await this.accounts.markModelLimited(account.id, model, error.retryAfterMs, error.message, now);
        const message = `Hết quota ${account.name} / ${model} (${error.quotaScope ?? "không rõ phạm vi"}): thử lại sau ${retryAt.toISOString()}. Dữ liệu đã thu thập vẫn xem được.`;
        await this.record(clusterId, { analysisStatus: "quota", analysisError: message });
        return { status: "quota", message, retryAt: retryAt.toISOString() };
      }
      const message = `Phân tích lỗi: ${error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE"}`;
      this.logger.warn(`trend analysis ${clusterId} failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      await this.record(clusterId, { analysisStatus: "failed", analysisError: message });
      return { status: "failed", message, retryAt: null };
    }
    if (!analysis) {
      await this.count(day, model, kind, "failures");
      const message = "AI trả kết quả không đầy đủ (thiếu góc khai thác / hook / độ tin cậy); không lưu bản phân tích dở.";
      await this.record(clusterId, { analysisStatus: "failed", analysisError: message });
      return { status: "failed", message, retryAt: null };
    }
    await this.record(clusterId, { analysis: analysis as unknown as Prisma.InputJsonValue, analysisStatus: "done", analysisError: null, analysisModel: account.isFake ? "fake" : model, analyzedAt: now });
    return { status: "done", message: null, retryAt: null };
  }
}
