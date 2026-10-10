import { Inject, Injectable, Logger } from "@nestjs/common";
import { rolloutNeedsFallback } from "@lyonix/domain";
import { COMPOSE_PROFILE_VERSION } from "@lyonix/media-jobs";
import { recipeRenderVerified } from "@lyonix/render-recipes";
import type { RenderEngineAdminOverviewResponse, RenderEngineAdminTemplateResponse, RenderEngineMetricsResponse } from "@lyonix/contracts";
import { PrismaService } from "./prisma.service.js";
import { FALLBACK_REASONS, loadRouterConfig } from "./internal-render.service.js";

/**
 * VE2E-118: admin view of the self-render engine. Two things, both from real data (no placeholders):
 *  - `overview`: per-template rollout controls + metrics aggregated from `RenderJob` rows (QC failures, fallbacks, render p50/p95, cost per day);
 *  - `updateTemplate`: set an internal template's `rolloutPercent` and `fallbackSnapshotIds`.
 * A PARTIAL rollout (1..99 %) needs at least one provider fallback: the jobs outside it go to the provider. V04-01 (owner decision 2b):
 * 100 % may be set without a fallback - the template then renders on the internal engine only, and an engine failure fails the job
 * clearly (the Router returns NO_FALLBACK_TEMPLATE) instead of silently sending it to a paid provider.
 * VE2E-157: raising a recipe's rollout needs a real-render verification of that recipe with the running engine output profile
 * (`renderVerified` in the recipe catalog) - a template is never switched on before its render was checked.
 */

export type MetricRow = {
  engine: string;
  routeReason: string | null;
  status: string;
  createdAt: Date;
  renderDurationMs: number | null;
  costAmount: unknown;
  qcReport: unknown;
};

export type RenderEngineMetrics = RenderEngineMetricsResponse;

const ENGINES = ["lyonix", "creatomate", "orshot"] as const;
const dayKey = (date: Date): string => date.toISOString().slice(0, 10);
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Nearest-rank percentile of an unsorted list; `null` for an empty list. */
export const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};

const failedQcCodes = (qcReport: unknown): string[] => {
  const checks = (qcReport as { checks?: unknown })?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.filter((check) => check && (check as { ok?: unknown }).ok === false && typeof (check as { code?: unknown }).code === "string").map((check) => (check as { code: string }).code);
};

/** Pure aggregation over job rows (exported for tests). `now` fixes the UTC day/month the budget block is measured against. */
export function summarizeRenderMetrics(rows: MetricRow[], options: { now: Date; days: number; dailyCeilingUsd: number; monthlyCeilingUsd: number | null }): RenderEngineMetrics {
  const since = new Date(options.now.getTime() - options.days * 86_400_000);
  const startOfDay = Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), options.now.getUTCDate());
  const startOfMonth = Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), 1);

  const byEngine = Object.fromEntries(ENGINES.map((engine) => [engine, { jobs: 0, completed: 0, failed: 0 }])) as RenderEngineMetrics["byEngine"];
  const qcFailuresByCode: Record<string, number> = {};
  const fallbackByReason: Record<string, number> = {};
  const renderTimes: number[] = [];
  const costByDay = new Map<string, { lyonix: number; creatomate: number; orshot: number }>();
  let qcFailed = 0;
  let fallbackTotal = 0;
  let fallbackToday = 0;
  let fallbackMonth = 0;
  const inWindow = rows.filter((row) => row.createdAt >= since);

  for (const row of inWindow) {
    const engine = (ENGINES as readonly string[]).includes(row.engine) ? (row.engine as (typeof ENGINES)[number]) : null;
    const cost = row.costAmount == null ? 0 : Number(row.costAmount);
    if (engine) {
      byEngine[engine].jobs += 1;
      if (row.status === "completed") byEngine[engine].completed += 1;
      if (row.status === "failed") byEngine[engine].failed += 1;
      const day = costByDay.get(dayKey(row.createdAt)) ?? { lyonix: 0, creatomate: 0, orshot: 0 };
      day[engine] += cost;
      costByDay.set(dayKey(row.createdAt), day);
    }
    if (row.engine === "lyonix") {
      const codes = failedQcCodes(row.qcReport);
      if (codes.length > 0) {
        qcFailed += 1;
        for (const code of new Set(codes)) qcFailuresByCode[code] = (qcFailuresByCode[code] ?? 0) + 1;
      }
      if (row.status === "completed" && row.renderDurationMs != null) renderTimes.push(row.renderDurationMs);
    }
    if (row.engine !== "lyonix" && row.routeReason && (FALLBACK_REASONS as readonly string[]).includes(row.routeReason)) {
      fallbackTotal += 1;
      fallbackByReason[row.routeReason] = (fallbackByReason[row.routeReason] ?? 0) + 1;
    }
  }
  // Budget is the calendar UTC day/month (not the reporting window), the same definition the Router gate uses.
  for (const row of rows) {
    if (row.engine === "lyonix" || !row.routeReason || !(FALLBACK_REASONS as readonly string[]).includes(row.routeReason)) continue;
    const cost = row.costAmount == null ? 0 : Number(row.costAmount);
    if (+row.createdAt >= startOfDay) fallbackToday += cost;
    if (+row.createdAt >= startOfMonth) fallbackMonth += cost;
  }

  const internalAttempts = byEngine.lyonix.jobs + fallbackTotal;
  return {
    windowDays: options.days,
    since: since.toISOString(),
    totalJobs: inWindow.length,
    byEngine,
    internal: {
      jobs: byEngine.lyonix.jobs,
      completed: byEngine.lyonix.completed,
      failed: byEngine.lyonix.failed,
      qcFailed,
      qcFailuresByCode,
      renderMs: { samples: renderTimes.length, p50: percentile(renderTimes, 50), p95: percentile(renderTimes, 95) },
    },
    fallbacks: { total: fallbackTotal, byReason: fallbackByReason, shareOfInternalAttempts: internalAttempts > 0 ? Math.round((fallbackTotal / internalAttempts) * 1000) / 1000 : null },
    costByDay: [...costByDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => ({ date, lyonix: round4(day.lyonix), creatomate: round4(day.creatomate), orshot: round4(day.orshot), total: round4(day.lyonix + day.creatomate + day.orshot) })),
    budget: { fallbackTodayUsd: round4(fallbackToday), fallbackMonthUsd: round4(fallbackMonth), dailyCeilingUsd: options.dailyCeilingUsd, monthlyCeilingUsd: options.monthlyCeilingUsd },
  };
}

export type AdminTemplateRow = RenderEngineAdminTemplateResponse;

export type AdminOverview = RenderEngineAdminOverviewResponse;

type Outcome<T> = { ok: true; data: T } | { ok: false; code: "VALIDATION_FAILED" | "NOT_FOUND"; message: string; status: number };

const MAX_FALLBACKS = 5;
const MAX_WINDOW_DAYS = 90;

@Injectable()
export class RenderEngineAdminService {
  private readonly logger = new Logger(RenderEngineAdminService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async overview(days = 7, now = new Date()): Promise<AdminOverview> {
    const windowDays = Number.isInteger(days) ? Math.min(Math.max(days, 1), MAX_WINDOW_DAYS) : 7;
    const config = loadRouterConfig();
    // month-to-date for the budget block, even when the reporting window is shorter than the current month
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const since = new Date(Math.min(now.getTime() - windowDays * 86_400_000, monthStart.getTime()));
    const [rows, internal, providers] = await Promise.all([
      this.prisma.renderJob.findMany({
        where: { createdAt: { gte: since } },
        select: { engine: true, routeReason: true, status: true, createdAt: true, renderDurationMs: true, costAmount: true, qcReport: true },
      }),
      this.prisma.templateSnapshot.findMany({ where: { engine: "lyonix" }, orderBy: { name: "asc" } }),
      this.prisma.templateSnapshot.findMany({ where: { engine: { in: ["creatomate", "orshot"] } }, orderBy: { capturedAt: "desc" }, take: 200 }),
    ]);
    const candidates = providers.map((snapshot) => ({ snapshotId: snapshot.id, name: snapshot.name, engine: snapshot.engine }));
    return {
      templates: internal.map((snapshot) => ({
        snapshotId: snapshot.id,
        name: snapshot.name,
        externalTemplateId: snapshot.externalTemplateId,
        rolloutPercent: snapshot.rolloutPercent,
        fallbackSnapshotIds: Array.isArray(snapshot.fallbackSnapshotIds) ? snapshot.fallbackSnapshotIds.filter((id): id is string => typeof id === "string") : [],
        fallbackCandidates: candidates,
      })),
      metrics: summarizeRenderMetrics(rows as MetricRow[], { now, days: windowDays, dailyCeilingUsd: config.fallbackDailyUsd, monthlyCeilingUsd: config.fallbackMonthlyUsd }),
    };
  }

  async updateTemplate(snapshotId: string, input: { rolloutPercent?: unknown; fallbackSnapshotIds?: unknown }, actorUserId: string): Promise<Outcome<AdminTemplateRow>> {
    const invalid = (message: string): Outcome<never> => ({ ok: false, code: "VALIDATION_FAILED", message, status: 400 });
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: snapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy mẫu", status: 404 };
    if (snapshot.engine !== "lyonix") return invalid("Chỉ mẫu engine nội bộ (lyonix) có rollout/dự phòng");

    const currentFallbacks = Array.isArray(snapshot.fallbackSnapshotIds) ? snapshot.fallbackSnapshotIds.filter((id): id is string => typeof id === "string") : [];
    let rolloutPercent = snapshot.rolloutPercent;
    if (input.rolloutPercent !== undefined) {
      if (typeof input.rolloutPercent !== "number" || !Number.isInteger(input.rolloutPercent) || input.rolloutPercent < 0 || input.rolloutPercent > 100) return invalid("rolloutPercent phải là số nguyên 0..100");
      rolloutPercent = input.rolloutPercent;
    }
    let fallbackSnapshotIds = currentFallbacks;
    if (input.fallbackSnapshotIds !== undefined) {
      if (!Array.isArray(input.fallbackSnapshotIds) || input.fallbackSnapshotIds.some((id) => typeof id !== "string" || !id.trim())) return invalid("fallbackSnapshotIds phải là danh sách id");
      fallbackSnapshotIds = [...new Set((input.fallbackSnapshotIds as string[]).map((id) => id.trim()))];
      if (fallbackSnapshotIds.length > MAX_FALLBACKS) return invalid(`Tối đa ${MAX_FALLBACKS} mẫu dự phòng`);
      const found = fallbackSnapshotIds.length ? await this.prisma.templateSnapshot.findMany({ where: { id: { in: fallbackSnapshotIds } } }) : [];
      const bad = fallbackSnapshotIds.find((id) => !found.some((row) => row.id === id && row.engine !== "lyonix"));
      if (bad) return invalid(`Mẫu dự phòng ${bad} không tồn tại hoặc không phải mẫu provider (creatomate/orshot)`);
    }
    const recipeId = /^recipe:(.+)@\d+$/.exec(snapshot.externalTemplateId)?.[1] ?? null;
    if (rolloutPercent > snapshot.rolloutPercent && (!recipeId || !recipeRenderVerified(recipeId, COMPOSE_PROFILE_VERSION))) {
      return invalid(`Mẫu ${recipeId ?? snapshot.externalTemplateId} chưa qua kiểm thử render thật với engine hiện tại (${COMPOSE_PROFILE_VERSION}): chưa thể tăng rollout.`);
    }
    if (rolloutNeedsFallback(rolloutPercent) && fallbackSnapshotIds.length === 0) {
      return invalid("Rollout một phần (1–99 %) cần ít nhất một mẫu provider dự phòng cho các job ngoài rollout. 0 % và 100 % không bắt buộc (100 % không có dự phòng: engine lỗi thì job lỗi, không chuyển sang provider).");
    }

    const updated = await this.prisma.templateSnapshot.update({ where: { id: snapshotId }, data: { rolloutPercent, fallbackSnapshotIds } });
    this.logger.log(`template ${snapshotId}: rolloutPercent ${snapshot.rolloutPercent} -> ${rolloutPercent}, fallbacks ${currentFallbacks.length} -> ${fallbackSnapshotIds.length} (by user ${actorUserId})`);
    return {
      ok: true,
      data: { snapshotId: updated.id, name: updated.name, externalTemplateId: updated.externalTemplateId, rolloutPercent, fallbackSnapshotIds, fallbackCandidates: [] },
    };
  }
}
