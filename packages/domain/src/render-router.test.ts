import { describe, expect, it } from "vitest";
import { canaryBucket, checkBudget, DEFAULT_ROUTER_CONFIG, estimateProviderCostUsd, internalTemplateReadiness, isInRollout, rolloutNeedsFallback, routeRender, type RouterConfig, type RouterInput, type RouterTemplate } from "./render-router.js";

const internal = (over: Partial<RouterTemplate> = {}): RouterTemplate => ({
  snapshotId: "snap-lyonix",
  engine: "lyonix",
  providerOnly: false,
  rolloutPercent: 100,
  fallbackSnapshots: [{ snapshotId: "snap-creatomate", engine: "creatomate" }],
  ...over,
});

const input = (over: Partial<RouterInput> = {}): RouterInput => ({
  jobKey: "job-1",
  forcedEngine: null,
  template: internal(),
  local: { healthy: true, estimatedWaitMs: 0 },
  spend: { todayUsd: 0, monthUsd: 0 },
  fallbackCostUsd: 0.52,
  afterError: null,
  ...over,
});

const config = (over: Partial<RouterConfig> = {}): RouterConfig => ({ ...DEFAULT_ROUTER_CONFIG, ...over });

describe("routeRender - rule order (first match wins)", () => {
  it("defaults to the internal engine for an internal template inside its rollout", () => {
    expect(routeRender(input())).toEqual({ kind: "route", engine: "lyonix", snapshotId: "snap-lyonix", reason: "default", isFallback: false });
  });

  it("1. an admin-forced engine wins over everything (even an unhealthy engine, an exhausted budget and a 0 % rollout)", () => {
    const hostile = input({ forcedEngine: "lyonix", template: internal({ rolloutPercent: 0 }), local: { healthy: false, estimatedWaitMs: 9e9 }, spend: { todayUsd: 999, monthUsd: 999 } });
    expect(routeRender(hostile)).toEqual({ kind: "route", engine: "lyonix", snapshotId: "snap-lyonix", reason: "forced", isFallback: false });
    expect(routeRender(input({ forcedEngine: "creatomate" }))).toEqual({ kind: "route", engine: "creatomate", snapshotId: "snap-creatomate", reason: "forced", isFallback: false });
    expect(routeRender(input({ forcedEngine: "orshot" }))).toMatchObject({ kind: "fail", code: "NO_FALLBACK_TEMPLATE" });
    // forcing the template's own provider engine
    expect(routeRender(input({ forcedEngine: "creatomate", template: internal({ engine: "creatomate", snapshotId: "snap-c" }) }))).toMatchObject({ engine: "creatomate", reason: "forced", snapshotId: "snap-c" });
  });

  it("2. provider-owned templates go to their provider unchanged (Creatomate, Orshot), whatever the internal engine's state", () => {
    const creatomate = input({ template: internal({ engine: "creatomate", snapshotId: "snap-c", fallbackSnapshots: [] }), local: { healthy: false, estimatedWaitMs: 0 } });
    expect(routeRender(creatomate)).toEqual({ kind: "route", engine: "creatomate", snapshotId: "snap-c", reason: "template_requires_provider", isFallback: false });
    const orshot = input({ template: internal({ engine: "orshot", snapshotId: "snap-o", fallbackSnapshots: [] }) });
    expect(routeRender(orshot)).toEqual({ kind: "route", engine: "orshot", snapshotId: "snap-o", reason: "orshot_template", isFallback: false });
  });

  it("2. an internal template flagged providerOnly (flip, per-letter scale...) uses its provider snapshot, even with a budget of zero", () => {
    const decision = routeRender(input({ template: internal({ providerOnly: true }), spend: { todayUsd: 999, monthUsd: 999 } }));
    expect(decision).toEqual({ kind: "route", engine: "creatomate", snapshotId: "snap-creatomate", reason: "template_requires_provider", isFallback: false });
    expect(routeRender(input({ template: internal({ providerOnly: true, fallbackSnapshots: [] }) }))).toMatchObject({ kind: "fail", code: "NO_FALLBACK_TEMPLATE" });
  });

  it("3a. a job outside the rollout share is a canary holdout served by the provider; 0 % means the internal engine is never used by default", () => {
    const decision = routeRender(input({ template: internal({ rolloutPercent: 0 }) }));
    expect(decision).toEqual({ kind: "route", engine: "creatomate", snapshotId: "snap-creatomate", reason: "canary_holdout", isFallback: true });
    expect(routeRender(input({ template: internal({ rolloutPercent: 0, fallbackSnapshots: [] }) }))).toMatchObject({ kind: "fail", code: "NO_FALLBACK_TEMPLATE" });
  });

  it("3b. an unhealthy internal engine falls back (even when overflow is disabled)", () => {
    expect(routeRender(input({ local: { healthy: false, estimatedWaitMs: 0 } }))).toMatchObject({ kind: "route", engine: "creatomate", reason: "local_unhealthy", isFallback: true });
  });

  it("3c. overflow is OFF by default: a long queue stays on the internal engine; enabled, a wait beyond the SLA falls back", () => {
    const slow = input({ local: { healthy: true, estimatedWaitMs: 60 * 60_000 } });
    expect(routeRender(slow)).toMatchObject({ engine: "lyonix", reason: "default" });
    expect(routeRender(slow, config({ overflowEnabled: true }))).toMatchObject({ engine: "creatomate", reason: "overflow", isFallback: true });
    expect(routeRender(input({ local: { healthy: true, estimatedWaitMs: 60_000 } }), config({ overflowEnabled: true }))).toMatchObject({ engine: "lyonix" });
  });

  it("the canary check comes before health/overflow, health before overflow", () => {
    const both = input({ template: internal({ rolloutPercent: 0 }), local: { healthy: false, estimatedWaitMs: 9e9 } });
    expect(routeRender(both, config({ overflowEnabled: true }))).toMatchObject({ reason: "canary_holdout" });
    const unhealthyAndSlow = input({ local: { healthy: false, estimatedWaitMs: 9e9 } });
    expect(routeRender(unhealthyAndSlow, config({ overflowEnabled: true }))).toMatchObject({ reason: "local_unhealthy" });
  });
});

describe("routeRender - fallback after an internal-engine error", () => {
  const failed = (over: Partial<NonNullable<RouterInput["afterError"]>> = {}): RouterInput["afterError"] => ({ code: "QC_LOUDNESS", isInputError: false, alreadyFellBack: false, ...over });

  it("falls back once to the provider after a technical failure, with the reason fallback_after_error", () => {
    expect(routeRender(input({ afterError: failed() }))).toEqual({ kind: "route", engine: "creatomate", snapshotId: "snap-creatomate", reason: "fallback_after_error", isFallback: true });
  });
  it("never falls back for input-data errors (the provider would fail too) nor a second time", () => {
    expect(routeRender(input({ afterError: failed({ code: "SOURCE_NOT_FOUND", isInputError: true }) }))).toMatchObject({ kind: "fail", code: "INPUT_ERROR" });
    expect(routeRender(input({ afterError: failed({ alreadyFellBack: true }) }))).toMatchObject({ kind: "fail", code: "ALREADY_FELL_BACK" });
  });
  it("fails clearly when there is nothing to fall back to", () => {
    expect(routeRender(input({ afterError: failed(), template: internal({ fallbackSnapshots: [] }) }))).toMatchObject({ kind: "fail", code: "NO_FALLBACK_TEMPLATE" });
  });
});

describe("spend ceiling (budget_exhausted: no provider call)", () => {
  it("blocks every kind of fallback once the daily ceiling would be exceeded", () => {
    const spent = { todayUsd: 49.7, monthUsd: 100 };
    const cases: RouterInput[] = [
      input({ spend: spent, template: internal({ rolloutPercent: 0 }) }),
      input({ spend: spent, local: { healthy: false, estimatedWaitMs: 0 } }),
      input({ spend: spent, afterError: { code: "FFMPEG_FAILED", isInputError: false, alreadyFellBack: false } }),
    ];
    for (const c of cases) {
      const decision = routeRender(c);
      expect(decision).toMatchObject({ kind: "blocked", reason: "budget_exhausted" });
      if (decision.kind === "blocked") expect(decision.wouldRoute.engine).toBe("creatomate");
    }
    expect(routeRender(input({ spend: spent, local: { healthy: false, estimatedWaitMs: 0 } }, ))).toMatchObject({ kind: "blocked" });
    const overflow = input({ spend: spent, local: { healthy: true, estimatedWaitMs: 9e9 } });
    expect(routeRender(overflow, config({ overflowEnabled: true }))).toMatchObject({ kind: "blocked" });
  });
  it("allows a fallback that still fits and honours the monthly ceiling", () => {
    expect(routeRender(input({ spend: { todayUsd: 49.4, monthUsd: 0 }, local: { healthy: false, estimatedWaitMs: 0 } }))).toMatchObject({ kind: "route", isFallback: true });
    const monthly = routeRender(input({ spend: { todayUsd: 0, monthUsd: 99.9 }, local: { healthy: false, estimatedWaitMs: 0 } }), config({ fallbackMonthlyUsd: 100 }));
    expect(monthly).toMatchObject({ kind: "blocked", reason: "budget_exhausted" });
    if (monthly.kind === "blocked") expect(monthly.detail).toContain("tháng");
  });
  it("does not gate the internal engine, forced engines or provider-owned templates", () => {
    const broke = { todayUsd: 1e6, monthUsd: 1e6 };
    expect(routeRender(input({ spend: broke }))).toMatchObject({ kind: "route", engine: "lyonix" });
    expect(routeRender(input({ spend: broke, forcedEngine: "creatomate" }))).toMatchObject({ kind: "route", reason: "forced" });
    expect(routeRender(input({ spend: broke, template: internal({ engine: "creatomate", snapshotId: "c" }) }))).toMatchObject({ kind: "route", engine: "creatomate" });
  });
  it("checkBudget reports what is left", () => {
    expect(checkBudget({ todayUsd: 10, monthUsd: 0 }, 5, { fallbackDailyUsd: 50, fallbackMonthlyUsd: null })).toEqual({ ok: true, remainingDailyUsd: 40, remainingMonthlyUsd: null });
    expect(checkBudget({ todayUsd: 50, monthUsd: 0 }, 0.01, { fallbackDailyUsd: 50, fallbackMonthlyUsd: null })).toMatchObject({ ok: false, reason: "daily" });
    expect(checkBudget({ todayUsd: 50, monthUsd: 0 }, 0, { fallbackDailyUsd: 50, fallbackMonthlyUsd: null }).ok).toBe(true);
  });
});

describe("canary bucket", () => {
  it("is deterministic per (template, job) and roughly uniform", () => {
    expect(canaryBucket("t", "j")).toBe(canaryBucket("t", "j"));
    let inside = 0;
    const N = 5000;
    for (let i = 0; i < N; i += 1) if (isInRollout({ snapshotId: "t", rolloutPercent: 20 }, `job-${i}`)) inside += 1;
    expect(inside / N).toBeGreaterThan(0.17);
    expect(inside / N).toBeLessThan(0.23);
  });
  it("is monotonic: a job inside a smaller share stays inside a larger one; 0 and 100 are exact", () => {
    for (let i = 0; i < 500; i += 1) {
      const key = `job-${i}`;
      if (isInRollout({ snapshotId: "t", rolloutPercent: 10 }, key)) expect(isInRollout({ snapshotId: "t", rolloutPercent: 30 }, key)).toBe(true);
      expect(isInRollout({ snapshotId: "t", rolloutPercent: 0 }, key)).toBe(false);
      expect(isInRollout({ snapshotId: "t", rolloutPercent: 100 }, key)).toBe(true);
    }
  });
});

describe("estimateProviderCostUsd", () => {
  it("reproduces the plan's figures for a 70 s 1080p60 video (Creatomate ~0.52, Orshot ~0.33 USD)", () => {
    expect(estimateProviderCostUsd("creatomate", { durationSec: 70, width: 1080, height: 1920, fps: 60 })).toBeCloseTo(0.52, 1);
    expect(estimateProviderCostUsd("orshot", { durationSec: 70, width: 1080, height: 1920, fps: 60 })).toBeCloseTo(0.33, 1);
  });
});

describe("V04-01: internal template readiness (one rule for Auto and Studio)", () => {
  it("rollout 0 % is never ready, whatever the fallback", () => {
    expect(internalTemplateReadiness({ rolloutPercent: 0, usableFallbackCount: 0 })).toEqual({ ready: false, reason: "rollout_off" });
    expect(internalTemplateReadiness({ rolloutPercent: 0, usableFallbackCount: 2, engineAvailable: true })).toEqual({ ready: false, reason: "rollout_off" });
  });
  it("a partial rollout needs a usable fallback; 100 % does not", () => {
    expect(internalTemplateReadiness({ rolloutPercent: 50, usableFallbackCount: 0 })).toEqual({ ready: false, reason: "no_fallback" });
    expect(internalTemplateReadiness({ rolloutPercent: 50, usableFallbackCount: 1 })).toEqual({ ready: true, hasFallback: true });
    expect(internalTemplateReadiness({ rolloutPercent: 100, usableFallbackCount: 0 })).toEqual({ ready: true, hasFallback: false });
    expect([0, 1, 50, 99, 100].map(rolloutNeedsFallback)).toEqual([false, true, true, true, false]);
  });
  it("a stopped engine blocks only when nothing could take over", () => {
    expect(internalTemplateReadiness({ rolloutPercent: 100, usableFallbackCount: 0, engineAvailable: false })).toEqual({ ready: false, reason: "engine_unavailable" });
    expect(internalTemplateReadiness({ rolloutPercent: 100, usableFallbackCount: 1, engineAvailable: false })).toEqual({ ready: true, hasFallback: true });
    expect(internalTemplateReadiness({ rolloutPercent: 100, usableFallbackCount: 0, engineAvailable: true })).toEqual({ ready: true, hasFallback: false });
  });
  it("rollout 100 % without a fallback renders internally, and an engine failure fails the job without calling any provider", () => {
    const solo = internal({ fallbackSnapshots: [] });
    expect(routeRender(input({ template: solo }))).toMatchObject({ kind: "route", engine: "lyonix", reason: "default" });
    expect(routeRender(input({ template: solo, local: { healthy: false, estimatedWaitMs: 0 } }))).toMatchObject({ kind: "fail", code: "NO_FALLBACK_TEMPLATE" });
    expect(routeRender(input({ template: solo, afterError: { code: "FFMPEG_FAILED", isInputError: false, alreadyFellBack: false } }))).toMatchObject({ kind: "fail", code: "NO_FALLBACK_TEMPLATE" });
  });
});
