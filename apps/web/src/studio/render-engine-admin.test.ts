import { describe, expect, it } from "vitest";
import type { RenderEngineMetricsResponse } from "@lyonix/contracts";
import { budgetUsage, formatSeconds, formatShare, formatUsd, isDraftDirty, qcFailureList, qcFailureRate, isInternalOnlyRollout, rolloutDraftProblem } from "./render-engine-admin.js";

const metrics = (over: Partial<RenderEngineMetricsResponse["internal"]> = {}, budget: Partial<RenderEngineMetricsResponse["budget"]> = {}): RenderEngineMetricsResponse => ({
  windowDays: 7,
  since: "2031-03-08T12:00:00.000Z",
  totalJobs: 10,
  byEngine: { lyonix: { jobs: 8, completed: 6, failed: 2 }, creatomate: { jobs: 2, completed: 2, failed: 0 }, orshot: { jobs: 0, completed: 0, failed: 0 } },
  internal: { jobs: 8, completed: 6, failed: 2, qcFailed: 2, qcFailuresByCode: { QC_FREEZE: 1, QC_LOUDNESS: 2, QC_FPS: 1 }, renderMs: { samples: 6, p50: 41_200, p95: 128_000 }, ...over },
  fallbacks: { total: 2, byReason: { fallback_after_error: 2 }, shareOfInternalAttempts: 0.2 },
  costByDay: [],
  budget: { fallbackTodayUsd: 10, fallbackMonthUsd: 40, dailyCeilingUsd: 50, monthlyCeilingUsd: null, ...budget },
});

describe("render-engine-admin helpers (VE2E-118)", () => {
  it("formats durations, money and shares for the panel", () => {
    expect(formatSeconds(41_234)).toBe("41.2 s");
    expect(formatSeconds(128_000)).toBe("128 s");
    expect(formatSeconds(null)).toBe("–");
    expect(formatUsd(0.52)).toBe("$0.52");
    expect(formatUsd(250)).toBe("$250");
    expect(formatShare(0.0345)).toBe("3.5%");
    expect(formatShare(0.2)).toBe("20%");
    expect(formatShare(null)).toBe("–");
  });

  it("derives the QC failure rate and a most-frequent-first code list", () => {
    expect(qcFailureRate(metrics())).toBeCloseTo(2 / 8, 5);
    expect(qcFailureRate(metrics({ completed: 0, failed: 0, qcFailed: 0 }))).toBeNull();
    expect(qcFailureList(metrics())).toEqual([{ code: "QC_LOUDNESS", count: 2 }, { code: "QC_FPS", count: 1 }, { code: "QC_FREEZE", count: 1 }]);
  });

  it("measures daily fallback budget usage, capped at 100% and treating a zero ceiling as exhausted", () => {
    expect(budgetUsage(metrics())).toBeCloseTo(0.2, 5);
    expect(budgetUsage(metrics({}, { fallbackTodayUsd: 80 }))).toBe(1);
    expect(budgetUsage(metrics({}, { dailyCeilingUsd: 0, fallbackTodayUsd: 0 }))).toBe(1);
  });

  it("applies the same save rule as the API: rollout above 0 needs a provider fallback", () => {
    expect(rolloutDraftProblem({ rolloutPercent: 0, fallbackSnapshotIds: [] })).toBeNull();
    expect(rolloutDraftProblem({ rolloutPercent: 25, fallbackSnapshotIds: [] })).toBe("needsFallback");
    expect(rolloutDraftProblem({ rolloutPercent: 25, fallbackSnapshotIds: ["s"] })).toBeNull();
    // V04-01: 100 % needs no fallback (internal engine only), a partial rollout still does
    expect(rolloutDraftProblem({ rolloutPercent: 100, fallbackSnapshotIds: [] })).toBeNull();
    expect(rolloutDraftProblem({ rolloutPercent: 99, fallbackSnapshotIds: [] })).toBe("needsFallback");
    expect(isInternalOnlyRollout({ rolloutPercent: 100, fallbackSnapshotIds: [] })).toBe(true);
    expect(isInternalOnlyRollout({ rolloutPercent: 100, fallbackSnapshotIds: ["s"] })).toBe(false);
    expect(rolloutDraftProblem({ rolloutPercent: 101, fallbackSnapshotIds: ["s"] })).toBe("range");
    expect(rolloutDraftProblem({ rolloutPercent: 2.5, fallbackSnapshotIds: ["s"] })).toBe("range");
  });

  it("detects unsaved changes", () => {
    const template = { snapshotId: "a", name: "n", externalTemplateId: "e", rolloutPercent: 10, fallbackSnapshotIds: ["x"], fallbackCandidates: [] };
    expect(isDraftDirty(template, { rolloutPercent: 10, fallbackSnapshotIds: ["x"] })).toBe(false);
    expect(isDraftDirty(template, { rolloutPercent: 50, fallbackSnapshotIds: ["x"] })).toBe(true);
    expect(isDraftDirty(template, { rolloutPercent: 10, fallbackSnapshotIds: ["x", "y"] })).toBe(true);
  });
});
