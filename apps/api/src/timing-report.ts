import { stageKind, summarizeTimings, type StageKind, type StageTiming } from "./stage-timing.js";

/**
 * Timing report of ONE Auto run (render performance audit): `report:timing -- <runId>`. Pure: takes the rows the main script
 * reads (run, StepRuns, provider operations, render jobs) and builds the per-stage table, the slowest stages and the
 * network / local / queue split. Runs recorded before stage timing existed fall back to their StepRun start/end.
 */
export type ReportStepRow = { stepKey: string; status: string; attempt: number; startedAt: Date | null; endedAt: Date | null; outputRef: unknown; error: unknown };
export type ReportOperationRow = { stepKey: string | null; provider: string | null; status: string; errorCode: string | null };
export type ReportRenderRow = { id: string; engine: string; status: string; createdAt: Date; submittedAt: Date | null; completedAt: Date | null; renderDurationMs: number | null; clipsTotal: number; errorCode: string | null };
export type TimingReportInput = { run: { id: string; status: string; attempts: number; createdAt: Date }; steps: ReportStepRow[]; operations: ReportOperationRow[]; renders: ReportRenderRow[] };

export type TimingReport = {
  runId: string;
  status: string;
  attempts: number;
  /** Run created -> last recorded moment (render completed / failed, or last stage). */
  totalMs: number;
  /** Run created -> first stage started (sat in the draft queue: worker not running / slots full). */
  queuedBeforeStartMs: number;
  source: "stage_timings" | "step_runs";
  events: Array<StageTiming & { kind: StageKind; offsetMs: number; scope: "run" | "render" }>;
  slowest: Array<{ stage: string; durationMs: number; kind: StageKind; provider: string | null }>;
  byKind: Record<StageKind, number>;
  cacheHits: string[];
  failures: Array<{ stage: string; code: string | null; attempt: number }>;
  renders: ReportRenderRow[];
};

/** StepRuns that only hold bookkeeping (their start/end are not a stage's real duration). */
const BOOKKEEPING = new Set(["stage_timings", "render_timings", "run_usage", "duration_budget", "media_plan_diagnostics", "keyword_extraction_diagnostics", "script_visual_plan_diagnostics", "quality_gate"]);

const isTimingList = (value: unknown): value is StageTiming[] =>
  Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as StageTiming).stage === "string" && typeof (item as StageTiming).durationMs === "number");

const eventsOf = (step: ReportStepRow | undefined): StageTiming[] | null => {
  const ref = step?.outputRef && typeof step.outputRef === "object" ? (step.outputRef as { events?: unknown }) : null;
  return ref && isTimingList(ref.events) ? ref.events : null;
};

function fromStepRuns(input: TimingReportInput): StageTiming[] {
  return input.steps
    .filter((step) => !BOOKKEEPING.has(step.stepKey) && step.startedAt && step.endedAt)
    .map((step) => {
      const operation = input.operations.find((row) => row.stepKey === step.stepKey);
      const code = step.error && typeof step.error === "object" && typeof (step.error as { code?: unknown }).code === "string" ? (step.error as { code: string }).code : undefined;
      return {
        stage: step.stepKey,
        startedAt: step.startedAt!.toISOString(),
        endedAt: step.endedAt!.toISOString(),
        durationMs: step.endedAt!.getTime() - step.startedAt!.getTime(),
        attempt: step.attempt,
        provider: operation?.provider ?? null,
        cache: "n/a" as const,
        ok: step.status !== "failed",
        ...(code ? { code } : {}),
      };
    });
}

/** Render stages of a render job recorded before `render_timings` existed: clip preparation + compose/provider wait from its row. */
function fromRenderRow(render: ReportRenderRow): StageTiming[] {
  const events: StageTiming[] = [];
  const base = { attempt: 1, provider: render.engine, cache: "n/a" as const };
  const end = render.completedAt ?? null;
  if (render.submittedAt) events.push({ ...base, stage: "render_prepare_clips", startedAt: render.createdAt.toISOString(), endedAt: render.submittedAt.toISOString(), durationMs: render.submittedAt.getTime() - render.createdAt.getTime(), ok: true });
  const from = render.submittedAt ?? render.createdAt;
  if (end) events.push({ ...base, stage: render.engine === "lyonix" ? "render_compose" : "render_provider", startedAt: from.toISOString(), endedAt: end.toISOString(), durationMs: end.getTime() - from.getTime(), ok: render.status === "completed", ...(render.errorCode ? { code: render.errorCode } : {}) });
  return events;
}

export function buildTimingReport(input: TimingReportInput): TimingReport {
  const latest = (key: string) => input.steps.filter((step) => step.stepKey === key).sort((a, b) => b.attempt - a.attempt)[0];
  const runEvents = eventsOf(latest("stage_timings"));
  const renderEvents = eventsOf(latest("render_timings"));
  const run = (runEvents ?? fromStepRuns(input)).map((event) => ({ ...event, scope: "run" as const }));
  const render = (renderEvents ?? input.renders.flatMap(fromRenderRow)).map((event) => ({ ...event, scope: "render" as const }));
  const all = [...run, ...render];
  const runStart = input.run.createdAt.getTime();
  const summary = summarizeTimings(all);
  const lastMoment = Math.max(
    runStart,
    ...all.map((event) => Date.parse(event.endedAt)),
    ...input.renders.map((row) => (row.completedAt ?? row.submittedAt ?? row.createdAt).getTime()),
  );
  const firstStart = all.length ? Math.min(...all.map((event) => Date.parse(event.startedAt))) : runStart;
  return {
    runId: input.run.id,
    status: input.run.status,
    attempts: input.run.attempts,
    totalMs: lastMoment - runStart,
    queuedBeforeStartMs: Math.max(0, firstStart - runStart),
    source: runEvents ? "stage_timings" : "step_runs",
    events: all
      .map((event) => ({ ...event, kind: stageKind(event.stage), offsetMs: Date.parse(event.startedAt) - runStart }))
      .sort((a, b) => a.offsetMs - b.offsetMs || a.stage.localeCompare(b.stage)),
    slowest: summary.slowest.slice(0, 3).map((event) => ({ stage: event.stage, durationMs: event.durationMs, kind: stageKind(event.stage), provider: event.provider })),
    byKind: summary.byKind,
    cacheHits: summary.cacheHits,
    failures: [
      ...summary.failed,
      ...input.operations.filter((row) => row.status === "failed" && row.stepKey && !summary.failed.some((failed) => failed.stage === row.stepKey)).map((row) => ({ stage: row.stepKey!, code: row.errorCode, attempt: 0 })),
    ],
    renders: input.renders,
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function formatTimingReport(report: TimingReport): string {
  const lines: string[] = [];
  lines.push(`Run ${report.runId}  status=${report.status}  attempts=${report.attempts}  source=${report.source}`);
  lines.push(`Total ${seconds(report.totalMs)} (waited ${seconds(report.queuedBeforeStartMs)} in the queue before the first stage)`);
  lines.push("");
  lines.push("  start    duration  kind     cache  try  provider     stage");
  for (const event of report.events) {
    lines.push(`  +${seconds(event.offsetMs).padStart(7)}  ${seconds(event.durationMs).padStart(8)}  ${event.kind.padEnd(7)}  ${event.cache.padEnd(5)}  ${String(event.attempt).padStart(3)}  ${(event.provider ?? "-").padEnd(11)}  ${event.scope === "render" ? "render/" : ""}${event.stage}${event.ok ? "" : `  FAILED ${event.code ?? ""}`}`);
  }
  lines.push("");
  lines.push(`Slowest: ${report.slowest.map((row, index) => `${index + 1}. ${row.stage} ${seconds(row.durationMs)} (${row.kind}${row.provider ? `, ${row.provider}` : ""})`).join("  ")}`);
  lines.push(`Sum by kind (overlapping stages add up): network ${seconds(report.byKind.network)}, local ${seconds(report.byKind.local)}, queue ${seconds(report.byKind.queue)}`);
  lines.push(`Cache hits: ${report.cacheHits.length ? report.cacheHits.join(", ") : "none"}`);
  lines.push(`Failures/retries: ${report.failures.length ? report.failures.map((row) => `${row.stage}${row.code ? ` ${row.code}` : ""}${row.attempt > 1 ? ` (try ${row.attempt})` : ""}`).join(", ") : "none"}`);
  for (const render of report.renders) {
    lines.push(`Render ${render.id.slice(0, 8)} engine=${render.engine} status=${render.status} clips=${render.clipsTotal} ffmpeg=${render.renderDurationMs === null ? "-" : seconds(render.renderDurationMs)}${render.errorCode ? ` error=${render.errorCode}` : ""}`);
  }
  return lines.join("\n");
}
