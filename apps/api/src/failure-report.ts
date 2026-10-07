/**
 * VE2E-84 (CR-MEDIA-SLA-2026-10-07 P0-1): pure aggregation for the job failure baseline. No DB access here - `failure-report-main.ts`
 * feeds it read-only rows. Reuses the percentile/step helpers of the capacity report.
 */
import { stepDurations, toStat, type Stat, type StepSample } from "./capacity-report.js";

/** SLO of the owner (CR-MEDIA-SLA §7 Q4): p95 <= 300 s measured from the moment the run is claimed. */
export const SLO_SECONDS = 300;

export type FailureRun = {
  id: string;
  status: string;
  attempts: number;
  createdAt: Date;
  /** Fallback completion time (WorkflowRun.updatedAt) for completed runs without a RenderJob.completedAt. */
  updatedAt: Date;
  lastError: unknown;
  /** RenderJob.completedAt of the newest completed render, if any. */
  renderedAt: Date | null;
  /** Earliest StepRun.startedAt = the moment the run was claimed (claim itself is not persisted). */
  claimedAt: Date | null;
};

export type FailureStep = { stepKey: string; status: string; attempt: number; error: unknown };
export type CauseCount = { cause: string; count: number };

const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** `CODE | message` with ids/numbers/urls collapsed so the same failure groups together. Never keeps more than 120 chars of message. */
export const causeKey = (error: unknown): string | null => {
  const rec = asRecord(error);
  if (!rec) return typeof error === "string" && error ? error.slice(0, 120) : null;
  const code = typeof rec.code === "string" && rec.code ? rec.code : "UNKNOWN";
  const raw = typeof rec.message === "string" ? rec.message : "";
  const message = raw
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return message ? `${code} | ${message}` : code;
};

const rank = (counts: Map<string, number>, limit: number): CauseCount[] =>
  [...counts.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause)).slice(0, limit);

export const topCauses = (errors: readonly unknown[], limit = 10): CauseCount[] => {
  const counts = new Map<string, number>();
  for (const error of errors) {
    const key = causeKey(error);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rank(counts, limit);
};

export const countBy = <T>(items: readonly T[], keyOf: (item: T) => string | null | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    if (key) out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

export const ratio = (part: number, total: number): number | null => (total === 0 ? null : part / total);

export type RunSummary = {
  total: number;
  byStatus: Record<string, number>;
  rates: { failed: number | null; needs_input: number | null; blocked_provider: number | null; retried: number | null };
};

export const summarizeRuns = (runs: readonly FailureRun[]): RunSummary => {
  const byStatus = countBy(runs, (r) => r.status);
  const total = runs.length;
  return {
    total,
    byStatus,
    rates: {
      failed: ratio(byStatus.failed ?? 0, total),
      needs_input: ratio(byStatus.needs_input ?? 0, total),
      blocked_provider: ratio(byStatus.blocked_provider ?? 0, total),
      retried: ratio(runs.filter((r) => r.attempts > 1).length, total),
    },
  };
};

export type SloSummary = {
  /** Completed runs with a claim time. */
  considered: number;
  claimToCompletedSec: Stat;
  queueWaitSec: Stat;
  /** Share of runs finished within SLO_SECONDS of the claim. */
  withinSlo: number | null;
  p95WithinSlo: boolean | null;
  sloSeconds: number;
};

/** SLO clock = claim -> completed (CR §7 Q4); queue wait = createdAt -> claim, reported separately. Only completed runs. */
export const sloSummary = (runs: readonly FailureRun[]): SloSummary => {
  const totals: number[] = [];
  const waits: number[] = [];
  for (const run of runs) {
    if (run.status !== "completed" || !run.claimedAt) continue;
    const end = run.renderedAt ?? run.updatedAt;
    const total = (end.getTime() - run.claimedAt.getTime()) / 1000;
    if (Number.isFinite(total) && total >= 0) totals.push(total);
    const wait = (run.claimedAt.getTime() - run.createdAt.getTime()) / 1000;
    if (Number.isFinite(wait) && wait >= 0) waits.push(wait);
  }
  const claimToCompletedSec = toStat(totals);
  return {
    considered: totals.length,
    claimToCompletedSec,
    queueWaitSec: toStat(waits),
    withinSlo: ratio(totals.filter((s) => s <= SLO_SECONDS).length, totals.length),
    p95WithinSlo: totals.length === 0 ? null : claimToCompletedSec.p95 <= SLO_SECONDS,
    sloSeconds: SLO_SECONDS,
  };
};

/** Failed StepRun rows grouped by step (normalized) with their top causes. */
export const failedStepCauses = (steps: readonly FailureStep[], limit = 5): Array<{ step: string; failures: number; topCauses: CauseCount[] }> => {
  const byStep = new Map<string, FailureStep[]>();
  for (const step of steps) {
    if (step.status !== "failed") continue;
    const key = step.stepKey.replace(/^(generate_audio|import_media)_.+$/, "$1");
    byStep.set(key, [...(byStep.get(key) ?? []), step]);
  }
  return [...byStep.entries()]
    .map(([step, rows]) => ({ step, failures: rows.length, topCauses: topCauses(rows.map((r) => r.error), limit) }))
    .sort((a, b) => b.failures - a.failures);
};

export type MediaDiagnosticsSummary = {
  runsWithDiagnostics: number;
  segments: number;
  bySourceProvider: Record<string, number>;
  sourceProviderPct: Record<string, number>;
  /** L0-L6 tier or other tier field, when diagnostics carry one (VE2E-130); empty until then. */
  byTier: Record<string, number>;
  qualityDegradedSegments: number;
  qualityDegradedPct: number | null;
  runsWithQualityDegraded: number;
  fallbackReasons: CauseCount[];
  socialRejectReasons: CauseCount[];
  failedSegments: number;
  apifyUsage: { runs: number; seconds: number; usd: number; searchesReused: number; libraryReuses: number; runsReporting: number };
  visionUsage: { calls: number; moderated: number; skippedSegments: number; runsReporting: number };
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const tierOf = (seg: Record<string, unknown>): string | null => {
  for (const field of ["tier", "level", "sourceTier", "fallbackTier"]) {
    const v = seg[field];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return `L${v}`;
  }
  return null;
};

/** `outputRefs` = media_plan_diagnostics StepRun.outputRef values (`{segments, apifyUsage?, visionUsage?}`). All fields besides `segments` are optional. */
export const summarizeMediaDiagnostics = (outputRefs: readonly unknown[]): MediaDiagnosticsSummary => {
  const providers: Record<string, number> = {};
  const tiers: Record<string, number> = {};
  const fallback = new Map<string, number>();
  const rejects = new Map<string, number>();
  const apify = { runs: 0, seconds: 0, usd: 0, searchesReused: 0, libraryReuses: 0, runsReporting: 0 };
  const vision = { calls: 0, moderated: 0, skippedSegments: 0, runsReporting: 0 };
  let segments = 0;
  let degraded = 0;
  let failedSegments = 0;
  let runsDegraded = 0;
  let runsWithDiagnostics = 0;
  for (const ref of outputRefs) {
    const rec = asRecord(ref);
    if (!rec) continue;
    runsWithDiagnostics += 1;
    let runDegraded = false;
    for (const raw of Array.isArray(rec.segments) ? rec.segments : []) {
      const seg = asRecord(raw);
      if (!seg) continue;
      segments += 1;
      if (seg.sourcing === "failed") failedSegments += 1;
      const provider = typeof seg.sourceProvider === "string" ? seg.sourceProvider : "none";
      providers[provider] = (providers[provider] ?? 0) + 1;
      if (typeof seg.fallbackReason === "string" && seg.fallbackReason) fallback.set(seg.fallbackReason, (fallback.get(seg.fallbackReason) ?? 0) + 1);
      const tier = tierOf(seg);
      if (tier) tiers[tier] = (tiers[tier] ?? 0) + 1;
      if (seg.quality_degraded === true || seg.qualityDegraded === true) {
        degraded += 1;
        runDegraded = true;
      }
      const rejected = asRecord(asRecord(seg.apifyQuality)?.rejected);
      for (const [reason, n] of Object.entries(rejected ?? {})) rejects.set(reason, (rejects.get(reason) ?? 0) + num(n));
    }
    if (runDegraded) runsDegraded += 1;
    const a = asRecord(rec.apifyUsage);
    if (a) {
      apify.runsReporting += 1;
      apify.runs += num(a.runs);
      apify.seconds += num(a.seconds);
      apify.usd += num(a.usd);
      apify.searchesReused += num(a.searchesReused);
      apify.libraryReuses += num(a.libraryReuses);
    }
    const v = asRecord(rec.visionUsage);
    if (v) {
      vision.runsReporting += 1;
      vision.calls += num(v.calls);
      vision.moderated += num(v.moderated);
      vision.skippedSegments += num(v.skippedSegments);
    }
  }
  return {
    runsWithDiagnostics,
    segments,
    bySourceProvider: providers,
    sourceProviderPct: Object.fromEntries(Object.entries(providers).map(([k, n]) => [k, (n / segments) * 100])),
    byTier: tiers,
    qualityDegradedSegments: degraded,
    qualityDegradedPct: segments === 0 ? null : (degraded / segments) * 100,
    runsWithQualityDegraded: runsDegraded,
    fallbackReasons: rank(fallback, 10),
    socialRejectReasons: rank(rejects, 10),
    failedSegments,
    apifyUsage: apify,
    visionUsage: vision,
  };
};

export type StepStats = Record<string, Stat>;
export const stepStats = (samples: readonly StepSample[]): StepStats => stepDurations(samples);

export type FailureReport = {
  windowDays: number;
  since: string;
  runs: RunSummary;
  slo: SloSummary;
  topRunCauses: CauseCount[];
  failedSteps: Array<{ step: string; failures: number; topCauses: CauseCount[] }>;
  steps: StepStats;
  renderJobsByEngine: Record<string, Record<string, number>>;
  media: MediaDiagnosticsSummary;
};

const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
const sec = (n: number) => `${n.toFixed(1)}s`;

export const formatReport = (r: FailureReport): string => {
  const out: string[] = [];
  out.push(`Failure baseline: last ${r.windowDays} day(s) since ${r.since}`);
  out.push(`\nRuns: ${r.runs.total}  (${Object.entries(r.runs.byStatus).map(([k, v]) => `${k}=${v}`).join(" ") || "none"})`);
  out.push(`  failed ${pct(r.runs.rates.failed)}  needs_input ${pct(r.runs.rates.needs_input)}  blocked_provider ${pct(r.runs.rates.blocked_provider)}  retried(attempts>1) ${pct(r.runs.rates.retried)}`);
  out.push(`\nSLO (claim -> completed, target p95 <= ${r.slo.sloSeconds}s): n=${r.slo.considered}  p50 ${sec(r.slo.claimToCompletedSec.p50)}  p95 ${sec(r.slo.claimToCompletedSec.p95)}  max ${sec(r.slo.claimToCompletedSec.max)}  within SLO ${pct(r.slo.withinSlo)}  p95 ${r.slo.p95WithinSlo === null ? "n/a" : r.slo.p95WithinSlo ? "OK" : "OVER"}`);
  out.push(`  Queue wait (created -> claim): p50 ${sec(r.slo.queueWaitSec.p50)}  p95 ${sec(r.slo.queueWaitSec.p95)}  max ${sec(r.slo.queueWaitSec.max)}`);
  out.push("\nTop run failure causes (WorkflowRun.lastError):");
  for (const c of r.topRunCauses) out.push(`  ${String(c.count).padStart(4)}  ${c.cause}`);
  if (r.topRunCauses.length === 0) out.push("  none");
  out.push("\nFailed steps (StepRun.error):");
  for (const f of r.failedSteps) {
    out.push(`  ${f.step}: ${f.failures}`);
    for (const c of f.topCauses) out.push(`      ${String(c.count).padStart(4)}  ${c.cause}`);
  }
  if (r.failedSteps.length === 0) out.push("  none");
  out.push("\n" + "step".padEnd(28) + "     n     p50s     p95s     maxs");
  for (const [key, st] of Object.entries(r.steps).sort((a, b) => b[1].p95 - a[1].p95)) out.push(key.padEnd(28) + String(st.count).padStart(6) + st.p50.toFixed(1).padStart(9) + st.p95.toFixed(1).padStart(9) + st.max.toFixed(1).padStart(9));
  out.push("\nRender jobs by engine/status:");
  for (const [engine, byStatus] of Object.entries(r.renderJobsByEngine)) out.push(`  ${engine}: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const m = r.media;
  out.push(`\nMedia diagnostics: ${m.runsWithDiagnostics} run(s), ${m.segments} segment(s), failed segments ${m.failedSegments}`);
  out.push(`  sourceProvider: ${Object.entries(m.sourceProviderPct).map(([k, v]) => `${k} ${v.toFixed(1)}%`).join("  ") || "n/a"}`);
  out.push(`  tiers: ${Object.entries(m.byTier).sort().map(([k, v]) => `${k}=${v}`).join(" ") || "none recorded (field not present yet)"}`);
  out.push(`  quality_degraded: ${m.qualityDegradedSegments} segment(s) (${m.qualityDegradedPct === null ? "n/a" : m.qualityDegradedPct.toFixed(1) + "%"}), ${m.runsWithQualityDegraded} run(s)`);
  out.push(`  fallbackReason top: ${m.fallbackReasons.map((c) => `${c.cause}=${c.count}`).join(", ") || "none"}`);
  out.push(`  social reject reasons: ${m.socialRejectReasons.map((c) => `${c.cause}=${c.count}`).join(", ") || "none"}`);
  out.push(`  apifyUsage (${m.apifyUsage.runsReporting} run): runs ${m.apifyUsage.runs}, ${m.apifyUsage.seconds.toFixed(0)}s, USD ${m.apifyUsage.usd.toFixed(2)}, searchesReused ${m.apifyUsage.searchesReused}, libraryReuses ${m.apifyUsage.libraryReuses}`);
  out.push(`  visionUsage (${m.visionUsage.runsReporting} run): calls ${m.visionUsage.calls}, moderated ${m.visionUsage.moderated}, skippedSegments ${m.visionUsage.skippedSegments}`);
  return out.join("\n");
};
