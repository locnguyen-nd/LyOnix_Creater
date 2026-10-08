import { describe, expect, it } from "vitest";
import { causeKey, failedStepCauses, sloSummary, summarizeMediaDiagnostics, summarizeRuns, topCauses, type FailureRun } from "./failure-report.js";

const at = (sec: number) => new Date(Date.UTC(2026, 9, 7, 0, 0, sec));
const run = (over: Partial<FailureRun>): FailureRun => ({ id: "r", status: "completed", attempts: 1, createdAt: at(0), updatedAt: at(100), lastError: null, renderedAt: null, claimedAt: at(10), ...over });

describe("failure report", () => {
  it("groups causes after normalizing ids/numbers/urls", () => {
    expect(causeKey({ code: "X", message: "job 123 failed at https://a.b/c 9f1c2d3e-aaaa-bbbb-cccc-1234567890ab" })).toBe("X | job # failed at <url> <id>");
    const top = topCauses([{ code: "A", message: "n=1" }, { code: "A", message: "n=2" }, { code: "B" }, null]);
    expect(top).toEqual([{ cause: "A | n=#", count: 2 }, { cause: "B", count: 1 }]);
  });

  it("summarizes run statuses and rates", () => {
    const s = summarizeRuns([run({}), run({ status: "failed", attempts: 2 }), run({ status: "needs_input" }), run({ status: "blocked_provider" })]);
    expect(s.total).toBe(4);
    expect(s.rates.failed).toBe(0.25);
    expect(s.rates.retried).toBe(0.25);
    expect(summarizeRuns([]).rates.failed).toBeNull();
  });

  it("computes SLO from claim and queue wait separately", () => {
    const runs = [run({ renderedAt: at(110) }), run({ updatedAt: at(410) }), run({ status: "failed" }), run({ claimedAt: null })];
    const slo = sloSummary(runs);
    expect(slo.considered).toBe(2);
    expect(slo.claimToCompletedSec.max).toBe(400);
    expect(slo.queueWaitSec.p50).toBe(10);
    expect(slo.withinSlo).toBe(0.5);
    expect(slo.p95WithinSlo).toBe(false);
    expect(sloSummary([]).p95WithinSlo).toBeNull();
  });

  it("groups failed step causes by normalized step", () => {
    const out = failedStepCauses([
      { stepKey: "import_media_a", status: "failed", attempt: 1, error: { code: "E", message: "x" } },
      { stepKey: "import_media_b", status: "failed", attempt: 1, error: { code: "E", message: "x" } },
      { stepKey: "generate_script", status: "succeeded", attempt: 1, error: null },
    ]);
    expect(out).toEqual([{ step: "import_media", failures: 2, topCauses: [{ cause: "E | x", count: 2 }] }]);
  });

  it("aggregates diagnostics with optional fields missing", () => {
    const m = summarizeMediaDiagnostics([
      {
        segments: [{ sourceProvider: "apify", apifyQuality: { rejected: { too_short: 2 } } }, { sourceProvider: "pexels", fallbackReason: "no_results", quality_degraded: true, tier: "L4" }, { sourcing: "failed" }],
        apifyUsage: { runs: 2, seconds: 10, usd: 0.5, searchesReused: 1, libraryReuses: 0 },
        visionUsage: { calls: 3, moderated: 2, skippedSegments: 1 },
      },
      { segments: [] },
      null,
    ]);
    expect(m.runsWithDiagnostics).toBe(2);
    expect(m.segments).toBe(3);
    expect(m.bySourceProvider).toEqual({ apify: 1, pexels: 1, none: 1 });
    expect(m.byTier).toEqual({ L4: 1 });
    expect(m.qualityDegradedSegments).toBe(1);
    expect(m.fallbackReasons).toEqual([{ cause: "no_results", count: 1 }]);
    expect(m.socialRejectReasons).toEqual([{ cause: "too_short", count: 2 }]);
    expect(m.apifyUsage.usd).toBe(0.5);
    expect(m.visionUsage.calls).toBe(3);
    expect(m.failedSegments).toBe(1);
    expect(m.ossFetch).toMatchObject({ attempted: 0, ytDlp: 0, fellBackToApify: 0, failureCodes: [] });
  });

  it("VE2E-149: counts yt-dlp downloads, Apify fallbacks, failure codes and timings; social tiers are a provider/tier like any other", () => {
    const m = summarizeMediaDiagnostics([
      {
        segments: [
          { sourceProvider: "apify", apifyQuality: { downloader: "yt-dlp", ossFetchMs: 2000 } },
          { sourceProvider: "apify", apifyQuality: { downloader: "yt-dlp", ossFetchMs: 4000 } },
          { sourceProvider: "apify", apifyQuality: { downloader: "apify", ossFetchCode: "FETCH_FORBIDDEN", ossFetchMs: 9000 } },
          { sourceProvider: "social", sourceTier: "shorts" },
        ],
      },
    ]);
    expect(m.ossFetch).toEqual({ attempted: 3, ytDlp: 2, fellBackToApify: 1, failureCodes: [{ cause: "FETCH_FORBIDDEN", count: 1 }], p50Ms: 4000, p95Ms: 9000 });
    expect(m.bySourceProvider.social).toBe(1);
    expect(m.byTier.shorts).toBe(1);
  });
});
