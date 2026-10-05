import type { RenderEngineAdminTemplateResponse, RenderEngineMetricsResponse } from "@lyonix/contracts";

/** VE2E-118: pure helpers of the admin "Render engine" panel (no React, so they are unit-tested). */

export const ROLLOUT_STEPS = [0, 5, 10, 25, 50, 100] as const;

export const formatSeconds = (ms: number | null): string => (ms === null ? "–" : `${(ms / 1000).toFixed(ms >= 100_000 ? 0 : 1)} s`);
export const formatUsd = (usd: number): string => `$${usd.toFixed(usd >= 100 ? 0 : 2)}`;
export const formatShare = (share: number | null): string => (share === null ? "–" : `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`);

/** Share of finished internal renders that did not pass QC; `null` when there are none. */
export const qcFailureRate = (metrics: RenderEngineMetricsResponse): number | null => {
  const finished = metrics.internal.completed + metrics.internal.failed;
  return finished === 0 ? null : metrics.internal.qcFailed / finished;
};

/** QC failure codes, most frequent first. */
export const qcFailureList = (metrics: RenderEngineMetricsResponse): Array<{ code: string; count: number }> =>
  Object.entries(metrics.internal.qcFailuresByCode)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

/** Fraction (0..1) of the daily fallback ceiling already used today. */
export const budgetUsage = (metrics: RenderEngineMetricsResponse): number => (metrics.budget.dailyCeilingUsd > 0 ? Math.min(1, metrics.budget.fallbackTodayUsd / metrics.budget.dailyCeilingUsd) : 1);

export type RolloutDraft = { rolloutPercent: number; fallbackSnapshotIds: string[] };

/** Why a draft cannot be saved (mirrors the API rule), or `null` when it can. */
export function rolloutDraftProblem(draft: RolloutDraft): "needsFallback" | "range" | null {
  if (!Number.isInteger(draft.rolloutPercent) || draft.rolloutPercent < 0 || draft.rolloutPercent > 100) return "range";
  if (draft.rolloutPercent > 0 && draft.fallbackSnapshotIds.length === 0) return "needsFallback";
  return null;
}

export const isDraftDirty = (template: RenderEngineAdminTemplateResponse, draft: RolloutDraft): boolean =>
  template.rolloutPercent !== draft.rolloutPercent || template.fallbackSnapshotIds.join(",") !== draft.fallbackSnapshotIds.join(",");
