import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@lyonix/db";
import {
  TREND_CLUSTER_DEFAULTS,
  bandOf,
  clusterFor,
  dedupeTrendItems,
  isTrendCategory,
  isTrendStatus,
  normalizeHashtag,
  normalizeTrendTitle,
  normalizeTrendUrl,
  relevanceOf,
  scoreTrend,
  similarProductions,
  tiktokVideoIdOf,
  trendNotificationBand,
  trendNotificationKey,
  type ClusterCandidate,
  type NewsCategory,
  type PastProduction,
  type TrendBand,
  type TrendCategory,
  type TrendItemInput,
  type TrendMetrics,
  type TrendSourceStatus,
} from "@lyonix/domain";
import {
  ProviderError,
  TrendImportError,
  apifyTikTokTrendRunner,
  collectTikTokTrends,
  collectYahooTrends,
  fetchTikTokOembed,
  manualTikTokItem,
  probeApifyAccount,
  type NewsFetch,
  type TikTokTrendQuery,
  type TikTokTrendRunner,
  type TrendSourceOutcome,
} from "@lyonix/providers";
import type {
  TrendAnalysisResponse,
  TrendAnalyzeResponse,
  TrendAssigneeResponse,
  TrendClusterDetailResponse,
  TrendClusterListResponse,
  TrendClusterResponse,
  TrendDuplicateResponse,
  TrendImportResponse,
  TrendItemResponse,
  TrendOverviewResponse,
  TrendProductionRefResponse,
  TrendProviderIdResponse,
  TrendRunResponse,
  TrendRunSourceResponse,
  TrendSourceViewResponse,
} from "@lyonix/contracts";
import { NotificationsService } from "./notifications.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { TrendAnalysisService } from "./trend-analysis.service.js";
import { TrendRadarConfigService, type TrendRadarRuntimeConfig } from "./trend-radar-config.service.js";

/**
 * VE2E-158 Trend Radar - collection runs, topics and their use. Spec: .docs/specs/VE2E-158.md.
 *
 * A run (manual "Chạy ngay" or the scheduler) reads every RUNNABLE source in isolation - a failing / quota-exhausted source is recorded and
 * the others go on - normalises + de-duplicates the items, groups them into topics (clusters keep every source link), records observations
 * over time (cluster item counts per run, metric snapshots per video), re-scores the topics in the window with explanations, notifies each
 * active user once per topic per band, and auto-analyses at most the configured number of Hot topics per day. At most one run is active
 * (Postgres advisory lock + status check, also across API replicas); a run left `running` by a crashed process is failed after a timeout.
 *
 * No paid call happens unless an admin enabled the TikTok source with an Apify account; Yahoo only runs once the operator confirmed the
 * rights (see TrendRadarConfigService). Nothing is invented: metrics are only what a provider returned.
 */

export const TREND_RADAR_OPTIONS = "TREND_RADAR_OPTIONS";
export type TrendRadarOptions = {
  fetch?: NewsFetch;
  tiktokRunner?: TikTokTrendRunner;
  probeApify?: (token: string) => Promise<unknown>;
  now?: () => Date;
  /** A run still `running` after this long was abandoned (crashed process). */
  staleRunMs?: number;
  /** "Chạy ngay" again within this time returns the run that just happened (double clicks / impatient users). */
  manualCooldownMs?: number;
};

/** Arbitrary constant identifying the Trend Radar run lock among the application's advisory locks. */
const RUN_LOCK_KEY = 7_021_004_158;
const TIKTOK_RUN_TIMEOUT_SECS = 120;
const MAX_RESCORED = 500;

const PROVIDER_LABEL: Record<TrendProviderIdResponse, string> = { yahoo_news: "Yahoo!ニュース", tiktok: "TikTok (Apify)", manual: "Nhập URL thủ công" };

type SourceState = { provider: "yahoo_news" | "tiktok"; enabled: boolean; runnable: boolean; state: TrendSourceStatus | null; message: string | null };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const metricsOf = (value: unknown): TrendMetrics | null => (value && typeof value === "object" ? (value as TrendMetrics) : null);
const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

type ClusterRow = Prisma.TrendClusterGetPayload<{ include: { items: true; assignments: { include: { user: { select: { displayName: true } } } } } }>;
type ItemRow = Prisma.TrendItemGetPayload<Record<string, never>>;

const toItem = (row: ItemRow): TrendItemResponse => ({
  id: row.id,
  provider: row.provider as TrendProviderIdResponse,
  sourceId: row.sourceId,
  url: row.url,
  title: row.title,
  author: row.author,
  publisher: row.publisher,
  excerpt: row.excerpt,
  thumbnailUrl: row.thumbnailUrl,
  hashtags: strings(row.hashtags),
  category: row.category,
  publishedAt: iso(row.publishedAt),
  collectedAt: row.collectedAt.toISOString(),
  metrics: metricsOf(row.metrics),
  completeness: row.completeness as TrendItemResponse["completeness"],
});

const bestMetrics = (items: readonly ItemRow[]): TrendMetrics | null =>
  items.map((item) => metricsOf(item.metrics)).filter((metrics): metrics is TrendMetrics => metrics !== null).sort((a, b) => (b.views ?? -1) - (a.views ?? -1))[0] ?? null;

function toCluster(row: ClusterRow): TrendClusterResponse {
  const breakdown = (row.scoreBreakdown ?? {}) as { components?: TrendClusterResponse["components"]; notes?: string[] };
  const items = [...row.items].sort((a, b) => (b.publishedAt?.getTime() ?? b.collectedAt.getTime()) - (a.publishedAt?.getTime() ?? a.collectedAt.getTime()));
  const analysis = row.analysis as TrendAnalysisResponse | null;
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    status: (isTrendStatus(row.status) ? row.status : "new") as TrendClusterResponse["status"],
    saved: row.saved,
    score: row.score,
    band: row.band as TrendBand,
    components: breakdown.components ?? [],
    notes: breakdown.notes ?? [],
    itemCount: row.items.length,
    providers: [...new Set(row.items.map((item) => item.provider as TrendProviderIdResponse))],
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    latestPublishedAt: iso(items.find((item) => item.publishedAt)?.publishedAt ?? null),
    hashtags: [...new Set(row.items.flatMap((item) => strings(item.hashtags)))].slice(0, 20),
    metrics: bestMetrics(row.items),
    summaryVi: analysis?.summaryVi ?? null,
    analysisStatus: row.analysisStatus as TrendClusterResponse["analysisStatus"],
    assignments: row.assignments.map((assignment) => ({ userId: assignment.userId, displayName: assignment.user.displayName, angleIndex: assignment.angleIndex, angleTitle: assignment.angleTitle, createdAt: assignment.createdAt.toISOString() })),
    productionRefs: (Array.isArray(row.productionRefs) ? row.productionRefs : []) as TrendProductionRefResponse[],
    topItems: items.slice(0, 3).map(toItem),
  };
}

const CLUSTER_INCLUDE = { items: true, assignments: { include: { user: { select: { displayName: true } } } } } as const;

const toRun = (row: Prisma.TrendRunGetPayload<Record<string, never>>): TrendRunResponse => ({
  id: row.id,
  trigger: row.trigger as TrendRunResponse["trigger"],
  status: row.status as TrendRunResponse["status"],
  requestedByUserId: row.requestedByUserId,
  createdAt: row.createdAt.toISOString(),
  startedAt: iso(row.startedAt),
  finishedAt: iso(row.finishedAt),
  sources: (Array.isArray(row.sources) ? row.sources : []) as TrendRunSourceResponse[],
  fetchedCount: row.fetchedCount,
  newCount: row.newCount,
  duplicateCount: row.duplicateCount,
  clusterCount: row.clusterCount,
  notifiedCount: row.notifiedCount,
  analysedCount: row.analysedCount,
  error: (row.error ?? null) as TrendRunResponse["error"],
});

export type ClusterFilters = {
  provider?: string;
  sinceHours?: number;
  category?: string;
  minScore?: number;
  status?: string;
  band?: string;
  q?: string;
  assigneeId?: string;
  saved?: boolean;
  limit?: number;
  offset?: number;
};

@Injectable()
export class TrendRadarService {
  private readonly logger = new Logger(TrendRadarService.name);
  private readonly inflight = new Set<Promise<void>>();
  private readonly fetchImpl: NewsFetch;
  private readonly tiktokRunner: TikTokTrendRunner;
  private readonly probeApify: (token: string) => Promise<unknown>;
  private readonly now: () => Date;
  private readonly staleRunMs: number;
  private readonly manualCooldownMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TrendRadarConfigService) private readonly config: TrendRadarConfigService,
    @Inject(TrendAnalysisService) private readonly analysis: TrendAnalysisService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Optional() @Inject(TREND_RADAR_OPTIONS) options?: TrendRadarOptions,
  ) {
    this.fetchImpl = options?.fetch ?? ((url, init) => fetch(url, init));
    this.tiktokRunner = options?.tiktokRunner ?? apifyTikTokTrendRunner();
    this.probeApify = options?.probeApify ?? ((token) => probeApifyAccount(token));
    this.now = options?.now ?? (() => new Date());
    this.staleRunMs = options?.staleRunMs ?? 30 * 60_000;
    this.manualCooldownMs = options?.manualCooldownMs ?? 60_000;
  }

  /** Waits for runs started in this process (tests, graceful shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  // ------------------------------------------------------------------------------------------------------------ sources

  private tiktokQueries(config: TrendRadarRuntimeConfig): TikTokTrendQuery[] {
    return [...config.keywords.map((value) => ({ kind: "keyword" as const, value })), ...config.hashtags.map((value) => ({ kind: "hashtag" as const, value }))];
  }

  private async tiktokAccount(config: TrendRadarRuntimeConfig) {
    if (!config.tiktokAccountId) return null;
    return this.prisma.providerAccount.findFirst({ where: { id: config.tiktokAccountId, provider: "apify", deletedAt: null }, select: { id: true, name: true, status: true, enabled: true, encryptedSecret: true } });
  }

  /** Whether each source may run now, and why not. */
  async sourceStates(config: TrendRadarRuntimeConfig): Promise<SourceState[]> {
    const yahoo: SourceState = !config.yahooEnabled
      ? { provider: "yahoo_news", enabled: false, runnable: false, state: config.yahooRightsConfirmed ? "disabled" : "rights_unconfirmed", message: config.yahooRightsConfirmed ? "Đang tắt" : "Chưa xác nhận quyền sử dụng Yahoo! JAPAN RSS" }
      : !config.yahooRightsConfirmed
        ? { provider: "yahoo_news", enabled: true, runnable: false, state: "rights_unconfirmed", message: "Chưa xác nhận quyền sử dụng Yahoo! JAPAN RSS: không thu thập" }
        : config.yahooCategories.length === 0
          ? { provider: "yahoo_news", enabled: true, runnable: false, state: "disabled", message: "Chưa chọn danh mục Yahoo nào" }
          : { provider: "yahoo_news", enabled: true, runnable: true, state: null, message: null };
    let tiktok: SourceState;
    if (!config.tiktokEnabled) tiktok = { provider: "tiktok", enabled: false, runnable: false, state: "disabled", message: "Đang tắt" };
    else {
      const account = await this.tiktokAccount(config);
      if (!account) tiktok = { provider: "tiktok", enabled: true, runnable: false, state: "not_connected", message: "Chưa chọn tài khoản Apify cho TikTok" };
      else if (!account.enabled || account.status !== "verified") tiktok = { provider: "tiktok", enabled: true, runnable: false, state: "not_connected", message: `Tài khoản Apify ${account.name} chưa sẵn sàng (${account.enabled ? account.status : "đang tắt"})` };
      else if (this.tiktokQueries(config).length === 0) tiktok = { provider: "tiktok", enabled: true, runnable: false, state: "not_connected", message: "Chưa cấu hình từ khoá / hashtag tiếng Nhật cho TikTok" };
      else tiktok = { provider: "tiktok", enabled: true, runnable: true, state: null, message: null };
    }
    return [yahoo, tiktok];
  }

  // ------------------------------------------------------------------------------------------------------------ runs

  /**
   * Starts a run unless one is already active (then that one is returned: double clicks / a scheduler tick never create a second), or - for
   * the scheduler - unless the last run is more recent than the interval or no source can run. Serialised across replicas by an advisory lock.
   */
  async requestRun(trigger: "manual" | "schedule", userId: string | null): Promise<{ run: TrendRunResponse | null; started: boolean; reason: "started" | "already_running" | "just_ran" | "not_due" | "no_source" | "schedule_off" }> {
    const now = this.now();
    const config = await this.config.runtime();
    if (trigger === "schedule" && !config.scheduleEnabled) return { run: null, started: false, reason: "schedule_off" };
    const states = await this.sourceStates(config);
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_KEY})`;
      // a run left running by a crashed process
      await tx.trendRun.updateMany({ where: { status: { in: ["pending", "running"] }, createdAt: { lt: new Date(now.getTime() - this.staleRunMs) } }, data: { status: "failed", finishedAt: now, error: { code: "RUN_ABANDONED", message: "Lượt chạy bị gián đoạn (tiến trình dừng giữa chừng)" } } });
      const active = await tx.trendRun.findFirst({ where: { status: { in: ["pending", "running"] } }, orderBy: { createdAt: "desc" } });
      if (active) return { run: active, started: false, reason: "already_running" as const };
      if (trigger === "manual") {
        const recent = await tx.trendRun.findFirst({ where: { createdAt: { gte: new Date(now.getTime() - this.manualCooldownMs) } }, orderBy: { createdAt: "desc" } });
        if (recent) return { run: recent, started: false, reason: "just_ran" as const };
      }
      if (trigger === "schedule") {
        const last = await tx.trendRun.findFirst({ orderBy: { createdAt: "desc" } });
        if (last && now.getTime() - last.createdAt.getTime() < config.intervalMinutes * 60_000 * 0.9) return { run: null, started: false, reason: "not_due" as const };
        if (!states.some((state) => state.runnable)) return { run: null, started: false, reason: "no_source" as const };
      }
      const run = await tx.trendRun.create({ data: { trigger, status: "pending", requestedByUserId: userId, createdAt: now } });
      return { run, started: true, reason: "started" as const };
    });
    if (outcome.started && outcome.run) {
      const promise = this.execute(outcome.run.id).catch((error) => this.logger.error(`trend run ${outcome.run!.id} crashed: ${error instanceof Error ? error.message : String(error)}`));
      const tracked = promise.finally(() => this.inflight.delete(tracked));
      this.inflight.add(tracked);
    }
    return { run: outcome.run ? toRun(outcome.run) : null, started: outcome.started, reason: outcome.reason };
  }

  private async collect(state: SourceState, config: TrendRadarRuntimeConfig): Promise<{ result: TrendRunSourceResponse; items: TrendItemInput[] }> {
    const started = Date.now();
    const result: TrendRunSourceResponse = { provider: state.provider, status: state.state ?? "ok", fetched: 0, new: 0, duplicates: 0, units: [], error: state.message && !state.runnable ? { code: (state.state ?? "disabled").toUpperCase(), message: state.message } : null, durationMs: 0 };
    if (!state.runnable) return { result, items: [] };
    let outcome: TrendSourceOutcome;
    try {
      if (state.provider === "yahoo_news") outcome = await collectYahooTrends({ fetch: this.fetchImpl, categories: config.yahooCategories as NewsCategory[] });
      else {
        const account = await this.tiktokAccount(config);
        outcome = await collectTikTokTrends({ token: decryptSecret(account!.encryptedSecret), queries: this.tiktokQueries(config), limit: config.tiktokResultsPerQuery, maxQueries: config.tiktokMaxQueries, timeoutSecs: TIKTOK_RUN_TIMEOUT_SECS, run: this.tiktokRunner, now: this.now });
      }
    } catch (error) {
      result.status = "failed";
      result.error = { code: error instanceof ProviderError ? error.code : "SOURCE_FAILED", message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
      result.durationMs = Date.now() - started;
      return { result, items: [] };
    }
    result.units = outcome.units;
    const okUnits = outcome.units.filter((unit) => unit.ok).length;
    if (outcome.stopped) {
      result.status = outcome.stopped.code === "PROVIDER_QUOTA_EXHAUSTED" ? "quota_exhausted" : outcome.stopped.code === "PROVIDER_AUTH_INVALID" ? "not_connected" : "failed";
      result.error = outcome.stopped;
    } else if (okUnits === 0) {
      result.status = "failed";
      result.error = outcome.units.find((unit) => unit.error)?.error ?? { code: "SOURCE_FAILED", message: "Không đọc được nguồn" };
    } else if (okUnits < outcome.units.length) {
      result.status = "partial";
      result.error = outcome.units.find((unit) => unit.error)?.error ?? null;
    }
    const minViews = config.tiktokMinViews;
    const windowStart = this.now().getTime() - config.windowHours * 3_600_000;
    // filters: posted in the search window (when the source says when), TikTok at least the configured views (only when views are known)
    const items = outcome.items.filter((item) => (!item.publishedAt || Date.parse(item.publishedAt) >= windowStart) && (item.provider !== "tiktok" || minViews <= 0 || item.metrics?.views == null || item.metrics.views >= minViews));
    result.fetched = items.length;
    result.durationMs = Date.now() - started;
    return { result, items };
  }

  private async execute(runId: string): Promise<void> {
    const now = this.now();
    await this.prisma.trendRun.update({ where: { id: runId }, data: { status: "running", startedAt: now } });
    const config = await this.config.runtime();
    const states = await this.sourceStates(config);
    if (!states.some((state) => state.runnable)) {
      const sources = await Promise.all(states.map((state) => this.collect(state, config).then((entry) => entry.result)));
      await this.prisma.trendRun.update({
        where: { id: runId },
        data: { status: "failed", finishedAt: this.now(), sources: sources as unknown as Prisma.InputJsonValue, error: { code: "NO_SOURCE_AVAILABLE", message: `Không có nguồn nào chạy được: ${states.map((state) => `${PROVIDER_LABEL[state.provider]} - ${state.message ?? "tắt"}`).join("; ")}` } },
      });
      return;
    }

    // every source in isolation: one failing never stops the others
    const collected = await Promise.all(states.map((state) => this.collect(state, config).catch((error): { result: TrendRunSourceResponse; items: TrendItemInput[] } => ({ result: { provider: state.provider, status: "failed", fetched: 0, new: 0, duplicates: 0, units: [], error: { code: "SOURCE_FAILED", message: error instanceof Error ? error.message.slice(0, 300) : String(error) }, durationMs: 0 }, items: [] }))));
    const prepared = collected.flatMap((entry) => entry.items.map((item) => ({ ...item, canonicalUrl: normalizeTrendUrl(item.url) ?? item.url, normalizedTitle: normalizeTrendTitle(item.title) }))).filter((item) => item.normalizedTitle.length > 0);
    const { unique, duplicates: inRunDuplicates } = dedupeTrendItems(prepared);
    const persisted = await this.persist(unique, now);
    for (const entry of collected) {
      entry.result.new = persisted.byProvider[entry.result.provider]?.new ?? 0;
      entry.result.duplicates = (persisted.byProvider[entry.result.provider]?.duplicates ?? 0) + prepared.filter((item) => item.provider === entry.result.provider).length - unique.filter((item) => item.provider === entry.result.provider).length;
    }

    const rescored = await this.rescore(persisted.touched, config, now, runId);
    const notified = await this.notifyBands(rescored, config);
    const analysed = await this.autoAnalyse(rescored, config);

    const runnable = collected.filter((entry, index) => states[index]!.runnable).map((entry) => entry.result);
    const okCount = runnable.filter((result) => result.status === "ok").length;
    const failedCount = runnable.filter((result) => result.status === "failed" || result.status === "quota_exhausted" || result.status === "not_connected").length;
    const status = failedCount === 0 && okCount === runnable.length ? "completed" : failedCount === runnable.length ? "failed" : "partial";
    await this.prisma.trendRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: this.now(),
        sources: collected.map((entry) => entry.result) as unknown as Prisma.InputJsonValue,
        fetchedCount: prepared.length,
        newCount: persisted.created,
        duplicateCount: persisted.duplicates + inRunDuplicates,
        clusterCount: persisted.touched.size,
        notifiedCount: notified,
        analysedCount: analysed,
        ...(status === "failed" ? { error: { code: "ALL_SOURCES_FAILED", message: runnable.map((result) => `${PROVIDER_LABEL[result.provider]}: ${result.error?.message ?? result.status}`).join("; ") } } : {}),
      },
    });
  }

  /** Clusters seen in the window, with what clustering needs. */
  private async candidates(since: Date): Promise<ClusterCandidate[]> {
    const rows = await this.prisma.trendCluster.findMany({ where: { lastSeenAt: { gte: since } }, select: { id: true, normalizedTitle: true, items: { select: { normalizedTitle: true, canonicalUrl: true, hashtags: true } } }, take: 2000, orderBy: { lastSeenAt: "desc" } });
    return rows.map((row) => ({ id: row.id, titles: [row.normalizedTitle, ...row.items.map((item) => item.normalizedTitle)], urls: row.items.map((item) => item.canonicalUrl), hashtags: row.items.flatMap((item) => strings(item.hashtags)) }));
  }

  /** Stores the items: known ones refresh their metrics (a snapshot each time), new ones join / open a cluster. */
  private async persist(items: ReadonlyArray<TrendItemInput & { canonicalUrl: string; normalizedTitle: string }>, now: Date, importedByUserId: string | null = null, windowHours = 48): Promise<{ created: number; duplicates: number; touched: Set<string>; byProvider: Record<string, { new: number; duplicates: number }>; itemClusterIds: string[] }> {
    const candidates = await this.candidates(new Date(now.getTime() - windowHours * 3_600_000));
    const touched = new Set<string>();
    const byProvider: Record<string, { new: number; duplicates: number }> = {};
    const itemClusterIds: string[] = [];
    let created = 0;
    let duplicates = 0;
    const tally = (provider: string, key: "new" | "duplicates") => {
      byProvider[provider] ??= { new: 0, duplicates: 0 };
      byProvider[provider]![key] += 1;
    };
    for (const item of items) {
      const existing = await this.prisma.trendItem.findFirst({ where: { OR: [{ provider: item.provider, sourceId: item.sourceId }, { canonicalUrl: item.canonicalUrl }] } });
      if (existing) {
        duplicates += 1;
        tally(item.provider, "duplicates");
        touched.add(existing.clusterId);
        itemClusterIds.push(existing.clusterId);
        if (item.metrics) {
          await this.prisma.trendItem.update({ where: { id: existing.id }, data: { metrics: item.metrics as unknown as Prisma.InputJsonValue, completeness: "with_metrics" } });
          await this.prisma.trendItemSnapshot.create({ data: { itemId: existing.id, measuredAt: new Date(item.metrics.measuredAt), metrics: item.metrics as unknown as Prisma.InputJsonValue } });
        }
        await this.prisma.trendCluster.update({ where: { id: existing.clusterId }, data: { lastSeenAt: now } });
        continue;
      }
      const match = clusterFor({ normalizedTitle: item.normalizedTitle, canonicalUrl: item.canonicalUrl, hashtags: item.hashtags }, candidates, TREND_CLUSTER_DEFAULTS);
      let clusterId = match?.clusterId ?? null;
      if (!clusterId) {
        const cluster = await this.prisma.trendCluster.create({ data: { title: item.title.slice(0, 300), normalizedTitle: item.normalizedTitle, category: item.category, firstSeenAt: now, lastSeenAt: now } });
        clusterId = cluster.id;
        candidates.push({ id: clusterId, titles: [item.normalizedTitle], urls: [], hashtags: [] });
      }
      try {
        const row = await this.prisma.trendItem.create({
          data: {
            clusterId,
            provider: item.provider,
            sourceId: item.sourceId.slice(0, 200),
            canonicalUrl: item.canonicalUrl,
            url: item.url,
            title: item.title.slice(0, 500),
            normalizedTitle: item.normalizedTitle,
            author: item.author,
            publisher: item.publisher,
            excerpt: item.excerpt,
            thumbnailUrl: item.thumbnailUrl,
            hashtags: item.hashtags,
            keywords: item.keywords,
            category: item.category,
            publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
            collectedAt: now,
            metrics: item.metrics ? (item.metrics as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
            completeness: item.completeness,
            importedByUserId,
          },
        });
        if (item.metrics) await this.prisma.trendItemSnapshot.create({ data: { itemId: row.id, measuredAt: new Date(item.metrics.measuredAt), metrics: item.metrics as unknown as Prisma.InputJsonValue } });
      } catch (error) {
        // another run / an import stored it meanwhile (unique provider id / canonical URL): a duplicate, not an error
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          duplicates += 1;
          tally(item.provider, "duplicates");
          continue;
        }
        throw error;
      }
      const candidate = candidates.find((entry) => entry.id === clusterId)!;
      candidate.titles.push(item.normalizedTitle);
      candidate.urls.push(item.canonicalUrl);
      candidate.hashtags.push(...item.hashtags);
      await this.prisma.trendCluster.update({ where: { id: clusterId }, data: { lastSeenAt: now } });
      created += 1;
      tally(item.provider, "new");
      touched.add(clusterId);
      itemClusterIds.push(clusterId);
    }
    return { created, duplicates, touched, byProvider, itemClusterIds };
  }

  /** Re-scores the touched clusters and every other cluster still in the window (freshness changes with time); records a snapshot per run. */
  async rescore(touched: ReadonlySet<string>, config: TrendRadarRuntimeConfig, now: Date, runId: string | null): Promise<Array<{ id: string; score: number; band: TrendBand; title: string; notifiedBands: TrendBand[]; analysisStatus: string; providers: string[] }>> {
    const since = new Date(now.getTime() - config.windowHours * 3_600_000);
    const clusters = await this.prisma.trendCluster.findMany({
      where: { OR: [{ id: { in: [...touched] } }, { lastSeenAt: { gte: since } }] },
      include: { items: { include: { snapshots: { orderBy: { measuredAt: "desc" }, take: 2 } } }, snapshots: { orderBy: { measuredAt: "desc" }, take: 1 } },
      take: MAX_RESCORED,
      orderBy: { lastSeenAt: "desc" },
    });
    const out: Array<{ id: string; score: number; band: TrendBand; title: string; notifiedBands: TrendBand[]; analysisStatus: string; providers: string[] }> = [];
    for (const cluster of clusters) {
      if (cluster.items.length === 0) continue;
      const published = cluster.items.map((item) => item.publishedAt).filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime());
      const categories = cluster.items.map((item) => item.category).filter((category): category is string => Boolean(category));
      const dominant = categories.sort((a, b) => categories.filter((c) => c === b).length - categories.filter((c) => c === a).length)[0] ?? cluster.category;
      const category: TrendCategory | null = isTrendCategory(dominant) ? dominant : null;
      let viewsPerHour: number | null = null;
      for (const item of cluster.items) {
        const [latest, previous] = item.snapshots;
        const a = metricsOf(latest?.metrics);
        const b = metricsOf(previous?.metrics);
        if (!latest || !previous || a?.views == null || b?.views == null) continue;
        const hours = (latest.measuredAt.getTime() - previous.measuredAt.getTime()) / 3_600_000;
        if (hours <= 0) continue;
        const rate = Math.max(0, (a.views - b.views) / hours);
        viewsPerHour = viewsPerHour === null ? rate : Math.max(viewsPerHour, rate);
      }
      const lastSnapshot = cluster.snapshots[0] ?? null;
      const titles = cluster.items.map((item) => item.title);
      const hashtags = cluster.items.flatMap((item) => strings(item.hashtags));
      const result = scoreTrend(
        {
          now: now.toISOString(),
          publishedAt: published[0]?.toISOString() ?? null,
          firstSeenAt: cluster.firstSeenAt.toISOString(),
          providers: [...new Set(cluster.items.map((item) => item.provider))],
          origins: [...new Set(cluster.items.map((item) => item.publisher ?? item.author ?? item.provider))],
          appearances: { current: cluster.items.length, previous: lastSnapshot ? lastSnapshot.itemCount : null },
          metrics: bestMetrics(cluster.items),
          viewsPerHour,
          relevance: relevanceOf({ titles, hashtags, category }, config),
          category,
          alreadyHandled: cluster.status === "used" || cluster.status === "rejected",
          windowHours: config.windowHours,
        },
        config.thresholds,
      );
      await this.prisma.trendCluster.update({ where: { id: cluster.id }, data: { score: result.score, band: result.band, scoreBreakdown: { components: result.components, notes: result.notes, computedAt: now.toISOString() } as unknown as Prisma.InputJsonValue, itemCount: cluster.items.length, category } });
      if (runId && touched.has(cluster.id)) await this.prisma.trendClusterSnapshot.create({ data: { clusterId: cluster.id, runId, measuredAt: now, itemCount: cluster.items.length, score: result.score } });
      out.push({ id: cluster.id, score: result.score, band: result.band, title: cluster.title, notifiedBands: strings(cluster.notifiedBands) as TrendBand[], analysisStatus: cluster.analysisStatus, providers: [...new Set(cluster.items.map((item) => item.provider))] });
    }
    return out;
  }

  /** One notification per active user per topic per band reached (never again for the same / a lower band). Returns the topics notified. */
  private async notifyBands(clusters: ReadonlyArray<{ id: string; score: number; title: string; notifiedBands: TrendBand[]; providers: string[] }>, config: TrendRadarRuntimeConfig): Promise<number> {
    let notified = 0;
    let recipients: string[] | null = null;
    for (const cluster of clusters) {
      const band = trendNotificationBand(cluster.score, config.notifyMinScore, cluster.notifiedBands, config.thresholds);
      if (!band) continue;
      recipients ??= await this.notifications.activeUserIds();
      const label = band === "hot" ? "Hot" : band === "rising" ? "Rising" : band === "review" ? "Worth Reviewing" : "Low";
      await this.notifications.notify(recipients, {
        kind: "trend_radar",
        title: `${label} ${cluster.score}/100: ${cluster.title}`.slice(0, 300),
        body: `Nguồn: ${cluster.providers.map((provider) => PROVIDER_LABEL[provider as TrendProviderIdResponse] ?? provider).join(", ")}`,
        link: `/trend-radar?cluster=${cluster.id}`,
        dedupeKey: trendNotificationKey(cluster.id, band),
        data: { clusterId: cluster.id, band, score: cluster.score },
      });
      await this.prisma.trendCluster.update({ where: { id: cluster.id }, data: { notifiedBands: [...cluster.notifiedBands, band] } });
      notified += 1;
    }
    return notified;
  }

  /** Hot topics without an analysis, best first, until the daily auto cap (or a quota) stops it. */
  private async autoAnalyse(clusters: ReadonlyArray<{ id: string; score: number; band: TrendBand; analysisStatus: string }>, config: TrendRadarRuntimeConfig): Promise<number> {
    if (config.autoAnalysisPerDay <= 0) return 0;
    let analysed = 0;
    for (const cluster of [...clusters].filter((entry) => entry.band === "hot" && entry.analysisStatus !== "done").sort((a, b) => b.score - a.score)) {
      const outcome = await this.analysis.analyze(cluster.id, "auto").catch(() => ({ status: "failed" as const }));
      if (outcome.status === "done") analysed += 1;
      if (outcome.status === "limit" || outcome.status === "quota" || outcome.status === "not_configured") break;
    }
    return analysed;
  }

  // ------------------------------------------------------------------------------------------------------------ queries

  async listRuns(limit = 20): Promise<TrendRunResponse[]> {
    const rows = await this.prisma.trendRun.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(100, Math.max(1, limit)) });
    return rows.map(toRun);
  }

  async run(id: string): Promise<TrendRunResponse | null> {
    const row = await this.prisma.trendRun.findUnique({ where: { id } });
    return row ? toRun(row) : null;
  }

  /** "Hôm nay" = since 00:00 in Vietnam (UTC+7), where the team works. */
  private startOfToday(now: Date): Date {
    const local = new Date(now.getTime() + 7 * 3_600_000);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 7 * 3_600_000);
  }

  async overview(): Promise<TrendOverviewResponse> {
    const now = this.now();
    const config = await this.config.runtime();
    const since = new Date(now.getTime() - config.windowHours * 3_600_000);
    const [newToday, bands, lastRun, lastScheduled, states] = await Promise.all([
      this.prisma.trendCluster.count({ where: { firstSeenAt: { gte: this.startOfToday(now) } } }),
      this.prisma.trendCluster.groupBy({ by: ["band"], where: { lastSeenAt: { gte: since }, status: { notIn: ["rejected"] } }, _count: true }),
      this.prisma.trendRun.findFirst({ orderBy: { createdAt: "desc" } }),
      this.prisma.trendRun.findFirst({ where: { trigger: "schedule" }, orderBy: { createdAt: "desc" } }),
      this.sourceStates(config),
    ]);
    const countBand = (band: string) => bands.find((entry) => entry.band === band)?._count ?? 0;
    const last = lastRun ? toRun(lastRun) : null;
    const sources: TrendSourceViewResponse[] = [
      ...states.map((state) => {
        const ran = last?.sources.find((entry) => entry.provider === state.provider);
        const runState = state.runnable ? (ran?.status ?? "never_run") : (state.state ?? "disabled");
        return { provider: state.provider, label: PROVIDER_LABEL[state.provider], enabled: state.enabled, runnable: state.runnable, state: runState, message: state.runnable ? (ran?.error?.message ?? null) : state.message, termsUrl: state.provider === "yahoo_news" ? "https://news.yahoo.co.jp/rss" : null, lastRunAt: ran ? last!.createdAt : null } satisfies TrendSourceViewResponse;
      }),
      { provider: "manual", label: PROVIDER_LABEL.manual, enabled: true, runnable: true, state: "ok", message: "Dán URL TikTok để nhập (TikTok oEmbed: tiêu đề, tác giả, ảnh bìa - không có số liệu tương tác)", termsUrl: "https://developers.tiktok.com/doc/embed-videos/", lastRunAt: null },
    ];
    const problems = (last?.sources ?? []).filter((source) => source.error && source.status !== "disabled").map((source) => ({ provider: source.provider, code: source.error!.code, message: source.error!.message }));
    const nextRunAt = config.scheduleEnabled && states.some((state) => state.runnable) ? new Date(Math.max(now.getTime(), (lastScheduled ?? lastRun)?.createdAt.getTime() ?? now.getTime()) + (lastScheduled ?? lastRun ? config.intervalMinutes * 60_000 : 60_000)).toISOString() : null;
    return { newToday, hot: countBand("hot"), rising: countBand("rising"), review: countBand("review"), activeSources: states.filter((state) => state.runnable).length + 1, lastRun: last, nextRunAt, scheduleEnabled: config.scheduleEnabled, intervalMinutes: config.intervalMinutes, sources, problems };
  }

  async listClusters(filters: ClusterFilters): Promise<TrendClusterListResponse> {
    const where: Prisma.TrendClusterWhereInput = {
      ...(filters.sinceHours ? { lastSeenAt: { gte: new Date(this.now().getTime() - filters.sinceHours * 3_600_000) } } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.minScore !== undefined ? { score: { gte: filters.minScore } } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.band ? { band: filters.band } : {}),
      ...(filters.saved !== undefined ? { saved: filters.saved } : {}),
      ...(filters.provider ? { items: { some: { provider: filters.provider } } } : {}),
      ...(filters.assigneeId ? { assignments: { some: { userId: filters.assigneeId } } } : {}),
      ...(filters.q ? { OR: [{ title: { contains: filters.q, mode: "insensitive" as const } }, { items: { some: { OR: [{ title: { contains: filters.q, mode: "insensitive" as const } }, { url: { contains: filters.q } }] } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.trendCluster.findMany({ where, include: CLUSTER_INCLUDE, orderBy: [{ score: "desc" }, { lastSeenAt: "desc" }], take: Math.min(100, Math.max(1, filters.limit ?? 30)), skip: Math.max(0, filters.offset ?? 0) }),
      this.prisma.trendCluster.count({ where }),
    ]);
    return { items: rows.map(toCluster), total };
  }

  async clusterDetail(id: string): Promise<TrendClusterDetailResponse | null> {
    const row = await this.prisma.trendCluster.findUnique({ where: { id }, include: { ...CLUSTER_INCLUDE, snapshots: { orderBy: { measuredAt: "asc" }, take: 50 } } });
    if (!row) return null;
    const base = toCluster(row);
    return {
      ...base,
      items: [...row.items].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)).map(toItem),
      analysis: (row.analysis ?? null) as TrendAnalysisResponse | null,
      analysisError: row.analysisError,
      analysisModel: row.analysisModel,
      analyzedAt: iso(row.analyzedAt),
      history: row.snapshots.map((snapshot) => ({ measuredAt: snapshot.measuredAt.toISOString(), itemCount: snapshot.itemCount, score: snapshot.score })),
    };
  }

  /** Đã xem / Lưu / Bỏ qua / Duyệt. Rejecting or using a topic lowers its score at the next run (already handled). */
  async updateCluster(id: string, patch: { status?: unknown; saved?: unknown }, userId: string): Promise<TrendClusterDetailResponse | "not_found" | "invalid"> {
    const data: Prisma.TrendClusterUpdateInput = {};
    if (patch.status !== undefined) {
      if (!isTrendStatus(patch.status)) return "invalid";
      data.status = patch.status;
      if (patch.status !== "new") {
        data.reviewedByUserId = userId;
        data.reviewedAt = this.now();
      }
    }
    if (patch.saved !== undefined) {
      if (typeof patch.saved !== "boolean") return "invalid";
      data.saved = patch.saved;
    }
    const updated = await this.prisma.trendCluster.updateMany({ where: { id }, data: data as Prisma.TrendClusterUpdateManyMutationInput });
    if (updated.count === 0) return "not_found";
    return (await this.clusterDetail(id))!;
  }

  async analyze(id: string): Promise<TrendAnalyzeResponse | null> {
    if (!(await this.prisma.trendCluster.findUnique({ where: { id }, select: { id: true } }))) return null;
    const outcome = await this.analysis.analyze(id, "manual", this.now());
    return { ...outcome, cluster: (await this.clusterDetail(id))! };
  }

  /** Staff take a topic with an angle; an admin may assign anyone. Several people on one topic get different suggested angles (web). */
  async assign(id: string, input: { userId?: unknown; angleIndex?: unknown; angleTitle?: unknown; remove?: unknown }, actor: { id: string; role: "admin" | "staff" }): Promise<TrendClusterDetailResponse | "not_found" | "forbidden" | "invalid"> {
    const target = typeof input.userId === "string" && input.userId ? input.userId : actor.id;
    if (target !== actor.id && actor.role !== "admin") return "forbidden";
    const cluster = await this.prisma.trendCluster.findUnique({ where: { id }, select: { id: true, title: true } });
    if (!cluster) return "not_found";
    if (input.remove === true) {
      await this.prisma.trendAssignment.deleteMany({ where: { clusterId: id, userId: target } });
      return (await this.clusterDetail(id))!;
    }
    if (input.angleIndex !== undefined && input.angleIndex !== null && (typeof input.angleIndex !== "number" || !Number.isInteger(input.angleIndex) || input.angleIndex < 0 || input.angleIndex > 9)) return "invalid";
    const user = await this.prisma.user.findFirst({ where: { id: target, disabled: false }, select: { id: true } });
    if (!user) return "invalid";
    const angleIndex = typeof input.angleIndex === "number" ? input.angleIndex : null;
    const angleTitle = typeof input.angleTitle === "string" ? input.angleTitle.trim().slice(0, 200) || null : null;
    await this.prisma.trendAssignment.upsert({ where: { clusterId_userId: { clusterId: id, userId: target } }, create: { clusterId: id, userId: target, angleIndex, angleTitle, assignedByUserId: actor.id }, update: { angleIndex, angleTitle, assignedByUserId: actor.id } });
    // Handed to someone else: they get one in-app notification per topic + angle (the same hand-over twice is not repeated).
    if (target !== actor.id) {
      await this.notifications.notify([target], {
        kind: "trend_assignment",
        title: `Bạn được giao chủ đề: ${cluster.title}`.slice(0, 300),
        body: angleTitle ? `Góc khai thác: ${angleTitle}` : null,
        link: `/trend-radar?cluster=${id}`,
        dedupeKey: `trend-assign:${id}:${angleIndex ?? "none"}`,
        data: { clusterId: id, angleIndex },
      });
    }
    return (await this.clusterDetail(id))!;
  }

  async assignees(): Promise<TrendAssigneeResponse[]> {
    const users = await this.prisma.user.findMany({ where: { disabled: false, approved: true }, select: { id: true, displayName: true, role: true }, orderBy: { displayName: "asc" } });
    return users.map((user) => ({ id: user.id, displayName: user.displayName, role: user.role }));
  }

  /** Earlier jobs that look like this topic (same source link or similar title) in the last 60 days - shown before a new video is created. */
  async duplicates(id: string): Promise<TrendDuplicateResponse[] | null> {
    const cluster = await this.prisma.trendCluster.findUnique({ where: { id }, include: { items: { select: { title: true, url: true } } } });
    if (!cluster) return null;
    const analysis = cluster.analysis as TrendAnalysisResponse | null;
    const since = new Date(this.now().getTime() - 60 * 24 * 3_600_000);
    const [jobs, sources, scripts] = await Promise.all([
      this.prisma.productionRequest.findMany({ where: { createdAt: { gte: since } }, select: { id: true, topic: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 300 }),
      this.prisma.sourceVersion.findMany({ where: { createdAt: { gte: since } }, select: { id: true, originRef: true, rawText: true, createdAt: true, workflowRuns: { select: { id: true }, take: 1 } }, orderBy: { createdAt: "desc" }, take: 300 }),
      this.prisma.scriptDraftVersion.findMany({ where: { createdAt: { gte: since } }, select: { id: true, title: true, createdAt: true, sourceVersion: { select: { workflowRuns: { select: { id: true }, take: 1 } } } }, orderBy: { createdAt: "desc" }, take: 300 }),
    ]);
    const past: Array<PastProduction & { link: string | null; source: "job" | "video_production" | "script" }> = [
      ...jobs.map((job) => ({ kind: "job" as const, source: "job" as const, id: job.id, title: job.topic.split("\n")[0]!.slice(0, 200), sourceUrls: (job.topic.match(/https?:\/\/\S+/g) ?? []) as string[], createdAt: job.createdAt.toISOString(), link: `/jobs/${job.id}` })),
      ...sources.map((source) => {
        const runId = source.workflowRuns[0]?.id ?? null;
        const text = (source.rawText ?? source.originRef ?? "").split("\n")[0]!.slice(0, 200);
        return { kind: "video_production" as const, source: runId ? ("video_production" as const) : ("script" as const), id: runId ?? source.id, title: text, sourceUrls: [source.originRef, ...((source.rawText ?? "").match(/https?:\/\/\S+/g) ?? [])].filter((url): url is string => Boolean(url && /^https?:/.test(url))), createdAt: source.createdAt.toISOString(), link: runId ? `/video-productions/${runId}` : null };
      }),
      ...scripts.map((script) => {
        const runId = script.sourceVersion.workflowRuns[0]?.id ?? null;
        return { kind: "video_production" as const, source: runId ? ("video_production" as const) : ("script" as const), id: runId ?? script.id, title: script.title, sourceUrls: [], createdAt: script.createdAt.toISOString(), link: runId ? `/video-productions/${runId}` : null };
      }),
    ].filter((entry) => entry.title.trim().length > 0);
    const titles = [cluster.title, ...cluster.items.map((item) => item.title), ...(analysis?.titleJa ? [analysis.titleJa] : [])];
    const found = similarProductions({ titles, urls: cluster.items.map((item) => item.url) }, past);
    const seen = new Set<string>();
    const out: TrendDuplicateResponse[] = [];
    for (const entry of found) {
      const original = past.find((candidate) => candidate.id === entry.id && candidate.title === entry.title)!;
      const key = `${original.source}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: original.source, id: entry.id, title: entry.title, similarity: Math.round(entry.similarity * 100) / 100, reason: entry.reason, createdAt: entry.createdAt, link: original.link });
      if (out.length >= 10) break;
    }
    return out;
  }

  /** The video made from the topic (after the user confirmed it on the create-video page): the topic becomes "used" and keeps the link. */
  async linkProduction(id: string, input: { kind?: unknown; productionId?: unknown; angleIndex?: unknown }, userId: string): Promise<TrendClusterDetailResponse | "not_found" | "invalid"> {
    if ((input.kind !== "job" && input.kind !== "video_production") || typeof input.productionId !== "string" || !input.productionId) return "invalid";
    const cluster = await this.prisma.trendCluster.findUnique({ where: { id }, select: { productionRefs: true } });
    if (!cluster) return "not_found";
    const refs = (Array.isArray(cluster.productionRefs) ? cluster.productionRefs : []) as TrendProductionRefResponse[];
    if (!refs.some((ref) => ref.kind === input.kind && ref.id === input.productionId)) {
      refs.push({ kind: input.kind, id: input.productionId, at: this.now().toISOString(), byUserId: userId, angleIndex: typeof input.angleIndex === "number" && Number.isInteger(input.angleIndex) ? input.angleIndex : null });
    }
    await this.prisma.trendCluster.update({ where: { id }, data: { productionRefs: refs as unknown as Prisma.InputJsonValue, status: "used", reviewedByUserId: userId, reviewedAt: this.now() } });
    return (await this.clusterDetail(id))!;
  }

  /**
   * Manual import of a pasted TikTok URL. The URL is always kept; TikTok oEmbed adds title / author / thumbnail when it answers (never metrics).
   * A short link (vm.tiktok.com) is kept as given - it is not resolved by requesting TikTok pages.
   */
  async importUrl(rawUrl: unknown, userId: string): Promise<TrendImportResponse | { error: string }> {
    if (typeof rawUrl !== "string" || rawUrl.length > 500) return { error: "URL không hợp lệ" };
    const canonical = normalizeTrendUrl(rawUrl);
    if (!canonical) return { error: "URL không hợp lệ" };
    let host = "";
    try {
      host = new URL(canonical).hostname;
    } catch {
      return { error: "URL không hợp lệ" };
    }
    if (!/(^|\.)tiktok\.com$/i.test(host)) return { error: "Hiện chỉ nhập được URL video TikTok (tiktok.com/@tài-khoản/video/…)" };
    const existing = await this.prisma.trendItem.findFirst({ where: { canonicalUrl: canonical } });
    if (existing) return { cluster: (await this.clusterDetail(existing.clusterId))!, created: false, warning: "URL này đã có trong Trend Radar" };
    const now = this.now();
    let item: TrendItemInput;
    let warning: string | null = null;
    if (tiktokVideoIdOf(canonical)) {
      let oembed = null;
      try {
        oembed = await fetchTikTokOembed(canonical, this.fetchImpl);
      } catch (error) {
        warning = `Đã lưu URL nhưng không lấy được thông tin từ TikTok: ${error instanceof TrendImportError ? error.message : "lỗi không rõ"}`;
      }
      item = manualTikTokItem(canonical, oembed);
    } else {
      warning = "Link rút gọn: đã lưu URL như bạn nhập, chưa có tiêu đề / tác giả (hãy mở link và dán URL đầy đủ dạng tiktok.com/@tài-khoản/video/… để lấy thông tin).";
      item = { provider: "manual", sourceId: `url:${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`, title: canonical, url: canonical, author: null, publisher: null, publishedAt: null, excerpt: null, thumbnailUrl: null, hashtags: [], keywords: [], category: null, metrics: null, completeness: "user_supplied" };
    }
    const config = await this.config.runtime();
    const persisted = await this.persist([{ ...item, canonicalUrl: canonical, normalizedTitle: normalizeTrendTitle(item.title) || canonical }], now, userId, config.windowHours);
    const clusterId = persisted.itemClusterIds[0];
    if (!clusterId) return { error: "Không lưu được URL" };
    await this.rescore(new Set([clusterId]), config, now, null);
    return { cluster: (await this.clusterDetail(clusterId))!, created: persisted.created > 0, warning };
  }

  /** "Kiểm tra kết nối": Yahoo reports the rights state (nothing fetched without it); TikTok checks the Apify account with a free account call. */
  async testSource(provider: string): Promise<{ provider: string; ok: boolean; state: string; message: string }> {
    const config = await this.config.runtime();
    if (provider === "yahoo_news") {
      if (!config.yahooRightsConfirmed) return { provider, ok: false, state: "rights_unconfirmed", message: "Chưa xác nhận quyền sử dụng Yahoo! JAPAN RSS: không gửi request nào tới Yahoo." };
      try {
        const outcome = await collectYahooTrends({ fetch: this.fetchImpl, categories: config.yahooCategories.slice(0, 1) as NewsCategory[] });
        const unit = outcome.units[0];
        return unit?.ok ? { provider, ok: true, state: "ok", message: `Đọc được feed ${unit.unit} (${unit.count} mục)` } : { provider, ok: false, state: "failed", message: unit?.error?.message ?? "Không đọc được feed" };
      } catch (error) {
        return { provider, ok: false, state: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (provider === "tiktok") {
      const account = await this.tiktokAccount(config);
      if (!account) return { provider, ok: false, state: "not_connected", message: "Chưa chọn tài khoản Apify cho TikTok" };
      try {
        await this.probeApify(decryptSecret(account.encryptedSecret));
        return { provider, ok: true, state: "ok", message: `Tài khoản Apify ${account.name} hợp lệ (kiểm tra tài khoản, không chạy Actor - không biết còn credit hay không cho tới lần chạy đầu)` };
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
        return { provider, ok: false, state: code === "PROVIDER_QUOTA_EXHAUSTED" ? "quota_exhausted" : "not_connected", message: `${code}: ${error instanceof Error ? error.message.slice(0, 200) : ""}` };
      }
    }
    return { provider, ok: false, state: "unknown", message: "Nguồn không hợp lệ" };
  }

  /** Normalised hashtag list helper for the controller's filters. */
  static hashtagKey = normalizeHashtag;
  static bandOf = bandOf;
}
