import { describe, expect, it } from "vitest";
import { percentile, RenderEngineAdminService, summarizeRenderMetrics, type MetricRow } from "./render-engine-admin.service.js";

const NOW = new Date("2031-03-15T12:00:00Z");
const row = (over: Partial<MetricRow>): MetricRow => ({ engine: "lyonix", routeReason: "default", status: "completed", createdAt: new Date("2031-03-15T08:00:00Z"), renderDurationMs: 40_000, costAmount: 0, qcReport: null, ...over });
const qc = (...failed: string[]) => ({ passed: failed.length === 0, checks: [{ code: "QC_FPS", ok: true }, ...failed.map((code) => ({ code, ok: false }))], measured: {} });
const options = { now: NOW, days: 7, dailyCeilingUsd: 50, monthlyCeilingUsd: null };

describe("summarizeRenderMetrics (VE2E-118)", () => {
  it("counts engines, QC failures by code, render percentiles, fallbacks and cost per day", () => {
    const m = summarizeRenderMetrics(
      [
        row({ renderDurationMs: 30_000, costAmount: "0.0100" }),
        row({ renderDurationMs: 50_000 }),
        row({ renderDurationMs: 100_000, costAmount: 0.02 }),
        row({ status: "failed", renderDurationMs: null, qcReport: qc("QC_LOUDNESS", "QC_FREEZE") }),
        row({ status: "failed", renderDurationMs: null, qcReport: qc("QC_FREEZE") }),
        row({ engine: "creatomate", routeReason: "fallback_after_error", costAmount: "0.5200", createdAt: new Date("2031-03-14T10:00:00Z") }),
        row({ engine: "creatomate", routeReason: "template_requires_provider", costAmount: "0.3000" }),
        row({ engine: "orshot", routeReason: "canary_holdout", costAmount: "0.3300" }),
        row({ createdAt: new Date("2031-02-01T00:00:00Z") }), // outside the 7-day window
      ],
      options,
    );
    expect(m.totalJobs).toBe(8);
    expect(m.byEngine.lyonix).toEqual({ jobs: 5, completed: 3, failed: 2 });
    expect(m.byEngine.creatomate).toEqual({ jobs: 2, completed: 2, failed: 0 });
    expect(m.internal.qcFailed).toBe(2);
    expect(m.internal.qcFailuresByCode).toEqual({ QC_LOUDNESS: 1, QC_FREEZE: 2 });
    expect(m.internal.renderMs).toEqual({ samples: 3, p50: 50_000, p95: 100_000 });
    expect(m.fallbacks.total).toBe(2); // fallback_after_error + canary_holdout; template_requires_provider is a direct choice
    expect(m.fallbacks.byReason).toEqual({ fallback_after_error: 1, canary_holdout: 1 });
    expect(m.fallbacks.shareOfInternalAttempts).toBeCloseTo(2 / 7, 3);
    expect(m.costByDay).toEqual([
      { date: "2031-03-14", lyonix: 0, creatomate: 0.52, orshot: 0, total: 0.52 },
      { date: "2031-03-15", lyonix: 0.03, creatomate: 0.3, orshot: 0.33, total: 0.66 },
    ]);
  });

  it("measures the fallback budget against the UTC day and month (not the reporting window) with the Router's definition", () => {
    const m = summarizeRenderMetrics(
      [
        row({ engine: "creatomate", routeReason: "fallback_after_error", costAmount: "1.0000" }),
        row({ engine: "creatomate", routeReason: "fallback_after_error", costAmount: "2.0000", createdAt: new Date("2031-03-02T00:00:00Z") }),
        row({ engine: "orshot", routeReason: "forced", costAmount: "9.0000" }), // forced is a user choice: not budget spend
        row({ engine: "creatomate", routeReason: "fallback_after_error", costAmount: "4.0000", createdAt: new Date("2031-02-28T23:00:00Z") }),
      ],
      { ...options, days: 1, monthlyCeilingUsd: 300 },
    );
    expect(m.budget).toEqual({ fallbackTodayUsd: 1, fallbackMonthUsd: 3, dailyCeilingUsd: 50, monthlyCeilingUsd: 300 });
  });

  it("is empty-safe: no rows -> zero counts and null percentiles/share", () => {
    const m = summarizeRenderMetrics([], options);
    expect(m.totalJobs).toBe(0);
    expect(m.internal.renderMs).toEqual({ samples: 0, p50: null, p95: null });
    expect(m.fallbacks.shareOfInternalAttempts).toBeNull();
    expect(m.costByDay).toEqual([]);
  });

  it("percentile uses nearest-rank", () => {
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("RenderEngineAdminService.updateTemplate (VE2E-118)", () => {
  const make = () => {
    const snapshots: any[] = [
      { id: "lx", engine: "lyonix", name: "Broadcast", externalTemplateId: "recipe:a@1", rolloutPercent: 0, fallbackSnapshotIds: [] },
      { id: "cm", engine: "creatomate", name: "CM", externalTemplateId: "t1", rolloutPercent: 0, fallbackSnapshotIds: [] },
      { id: "lx2", engine: "lyonix", name: "Other", externalTemplateId: "recipe:b@1", rolloutPercent: 0, fallbackSnapshotIds: [] },
    ];
    const prisma: any = {
      templateSnapshot: {
        findUnique: async ({ where }: any) => snapshots.find((s) => s.id === where.id) ?? null,
        findMany: async ({ where }: any) => snapshots.filter((s) => where.id.in.includes(s.id)),
        update: async ({ where, data }: any) => Object.assign(snapshots.find((s) => s.id === where.id)!, data),
      },
    };
    return { service: new RenderEngineAdminService(prisma), snapshots };
  };

  it("sets rollout together with a provider fallback and persists both", async () => {
    const { service, snapshots } = make();
    const result = await service.updateTemplate("lx", { rolloutPercent: 25, fallbackSnapshotIds: ["cm", "cm"] }, "admin-1");
    expect(result).toMatchObject({ ok: true, data: { rolloutPercent: 25, fallbackSnapshotIds: ["cm"] } });
    expect(snapshots[0]).toMatchObject({ rolloutPercent: 25, fallbackSnapshotIds: ["cm"] });
  });

  it("refuses rollout > 0 without a fallback, lowering to 0 without one is fine, and an existing fallback is kept", async () => {
    const { service, snapshots } = make();
    expect(await service.updateTemplate("lx", { rolloutPercent: 10 }, "a")).toMatchObject({ ok: false, code: "VALIDATION_FAILED", status: 400 });
    expect(snapshots[0]!.rolloutPercent).toBe(0);
    await service.updateTemplate("lx", { fallbackSnapshotIds: ["cm"] }, "a");
    expect(await service.updateTemplate("lx", { rolloutPercent: 100 }, "a")).toMatchObject({ ok: true, data: { rolloutPercent: 100, fallbackSnapshotIds: ["cm"] } });
    expect(await service.updateTemplate("lx", { rolloutPercent: 0, fallbackSnapshotIds: [] }, "a")).toMatchObject({ ok: true });
  });

  it("validates ranges, ids and engine of the target and of the fallbacks", async () => {
    const { service } = make();
    for (const bad of [-1, 101, 12.5, "50", null]) expect(await service.updateTemplate("lx", { rolloutPercent: bad }, "a")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await service.updateTemplate("lx", { fallbackSnapshotIds: ["nope"] }, "a")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await service.updateTemplate("lx", { fallbackSnapshotIds: ["lx2"] }, "a")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" }); // an internal template is not a provider fallback
    expect(await service.updateTemplate("lx", { fallbackSnapshotIds: [1] }, "a")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await service.updateTemplate("cm", { rolloutPercent: 5 }, "a")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" }); // provider templates have no rollout
    expect(await service.updateTemplate("missing", { rolloutPercent: 0 }, "a")).toMatchObject({ ok: false, code: "NOT_FOUND", status: 404 });
  });
});
