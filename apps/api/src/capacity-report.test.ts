import { describe, expect, it } from "vitest";
import { endToEnd, isContinuousRun, normalizeStepKey, percentile, requiredConcurrency, requiredProviderSlots, stepDurations, toStat } from "./capacity-report.js";

const at = (sec: number) => new Date(Date.UTC(2026, 9, 2, 0, 0, sec));

describe("capacity report", () => {
  it("normalizes per-scene/segment step keys", () => {
    expect(normalizeStepKey("generate_audio_s03")).toBe("generate_audio");
    expect(normalizeStepKey("import_media_seg-2-b")).toBe("import_media");
    expect(normalizeStepKey("generate_script")).toBe("generate_script");
  });

  it("computes percentiles with interpolation", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([10], 0.95)).toBe(10);
    expect(toStat([1, 2, 3, 4, 5])).toEqual({ count: 5, p50: 3, p95: 4.8, max: 5 });
  });

  it("aggregates step durations and skips bookkeeping rows and negative spans", () => {
    const stats = stepDurations([
      { stepKey: "generate_audio_s01", startedAt: at(0), endedAt: at(6) },
      { stepKey: "generate_audio_s02", startedAt: at(0), endedAt: at(8) },
      { stepKey: "duration_budget", startedAt: at(0), endedAt: at(900) },
      { stepKey: "persist_script_version", startedAt: at(0), endedAt: at(1) },
      { stepKey: "import_media_seg-1", startedAt: at(10), endedAt: at(5) },
    ]);
    expect(Object.keys(stats)).toEqual(["generate_audio"]);
    expect(stats.generate_audio).toMatchObject({ count: 2, p50: 7, max: 8 });
  });

  it("measures end-to-end on first-attempt, continuous runs only", () => {
    const work = (s: number, e: number, stepKey?: string) => ({ ...(stepKey ? { stepKey } : {}), startedAt: at(s), endedAt: at(e) });
    const result = endToEnd([
      { runId: "a", createdAt: at(0), attempts: 1, renderedAt: at(200), renderSubmittedAt: at(140), renderDurationMs: 60_000, steps: [work(5, 60), work(60, 130, "submit_render")] },
      { runId: "b", createdAt: at(0), attempts: 1, renderedAt: at(400), renderSubmittedAt: at(310), renderDurationMs: null, steps: [work(5, 100), work(100, 300)] },
      { runId: "retry", createdAt: at(0), attempts: 2, renderedAt: at(5000), renderSubmittedAt: at(4930), renderDurationMs: 70_000, steps: [work(5, 100)] },
      { runId: "paused", createdAt: at(0), attempts: 1, renderedAt: at(9000), renderSubmittedAt: at(8900), renderDurationMs: null, steps: [work(5, 100), work(5000, 5100)] },
      { runId: "norender", createdAt: at(0), attempts: 1, renderedAt: null, renderSubmittedAt: null, renderDurationMs: null, steps: [work(5, 100)] },
    ]);
    expect(result).toMatchObject({ considered: 2, excluded: 2 });
    expect(result.endToEndSec.count).toBe(2);
    expect(result.withinTargetRatio).toBe(0.5);
    expect(result.activeSec).toMatchObject({ count: 2, p50: 295 });
    expect(result.queueWaitSec.max).toBe(5);
    expect(result.pipelineSec).toMatchObject({ count: 1, p50: 125 });
    expect(result.renderSec.p50).toBe(75);
    expect(result.renderSec.max).toBe(90);
    expect(endToEnd([]).withinTargetRatio).toBeNull();
  });

  it("treats queue wait before the first step as work, but a mid-run gap as a pause", () => {
    expect(isContinuousRun([{ startedAt: at(900), endedAt: at(950) }, { startedAt: at(960), endedAt: at(1000) }])).toBe(true);
    expect(isContinuousRun([{ startedAt: at(0), endedAt: at(50) }, { startedAt: at(300), endedAt: at(350) }])).toBe(false);
    expect(isContinuousRun([{ startedAt: at(0), endedAt: at(500) }, { startedAt: at(100), endedAt: at(150) }, { startedAt: at(520), endedAt: at(600) }])).toBe(true);
    expect(isContinuousRun([])).toBe(true);
    // diagnostics rows are created early and finalised late: they must not hide a real pause
    expect(isContinuousRun([{ stepKey: "duration_budget", startedAt: at(0), endedAt: at(9000) }, { startedAt: at(0), endedAt: at(50) }, { startedAt: at(500), endedAt: at(550) }])).toBe(false);
  });

  it("sizes concurrency and provider slots", () => {
    expect(requiredConcurrency(200, 300)).toBe(17);
    expect(requiredProviderSlots(50, 10, 7, 60)).toBe(59);
    expect(requiredProviderSlots(50, 1, 12, 40)).toBe(15);
  });
});
