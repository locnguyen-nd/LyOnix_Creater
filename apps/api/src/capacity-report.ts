/**
 * Capacity budget helper (DEC-2026-10-02-CAPACITY-250 / VE2E-70 input): pure p50/p95 aggregation over finished StepRun / RenderJob
 * rows. No DB access here - `capacity-report-main.ts` feeds it. Bookkeeping rows that are written as a single instant
 * (diagnostics, usage, persist/approve) are not provider/CPU work and are excluded so they do not pollute the step budget.
 */
export type StepSample = { stepKey: string; startedAt: Date; endedAt: Date };
export type RunSample = {
  runId: string;
  createdAt: Date;
  attempts: number;
  /** When the final MP4 became ready (RenderJob.completedAt). */
  renderedAt: Date | null;
  /** RenderJob.submittedAt; used for the render time when the provider did not report `render_duration`. */
  renderSubmittedAt: Date | null;
  renderDurationMs: number | null;
  /** This run's StepRun spans, to detect operator/needs_input pauses. */
  steps: ReadonlyArray<{ stepKey?: string; startedAt: Date; endedAt: Date }>;
};

export type Stat = { count: number; p50: number; p95: number; max: number };

/** Steps that are bookkeeping/diagnostics rows, not units of provider or CPU work. */
const BOOKKEEPING = /^(run_usage|duration_budget|media_plan_diagnostics|keyword_extraction_diagnostics|script_visual_plan_diagnostics|persist_[a-z_]+|approve_[a-z_]+|reuse_or_generate_script)$/;

/** `generate_audio_s03` -> `generate_audio`, `import_media_seg-2-b` -> `import_media`; other keys are kept as-is. */
export const normalizeStepKey = (key: string): string => key.replace(/^(generate_audio|import_media)_.+$/, "$1");

export const percentile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return 0;
  const rank = (sorted.length - 1) * q;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
};

export const toStat = (values: readonly number[]): Stat => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0 };
};

export const stepDurations = (samples: readonly StepSample[]): Record<string, Stat> => {
  const byStep = new Map<string, number[]>();
  for (const sample of samples) {
    if (BOOKKEEPING.test(sample.stepKey)) continue;
    const seconds = (sample.endedAt.getTime() - sample.startedAt.getTime()) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const key = normalizeStepKey(sample.stepKey);
    byStep.set(key, [...(byStep.get(key) ?? []), seconds]);
  }
  return Object.fromEntries([...byStep.entries()].map(([key, values]) => [key, toStat(values)]));
};

/** A gap longer than this between consecutive steps means the run sat waiting (needs_input / operator / outage), not working. */
export const PAUSE_GAP_SEC = 120;

/** True when no step started more than PAUSE_GAP_SEC after everything before it had ended. Queue wait before the first step is NOT a pause. */
/** Drops diagnostics/usage rows: they are created early and finalised much later, so their span says nothing about when work happened. */
const workSteps = <T extends { stepKey?: string }>(steps: ReadonlyArray<T>): T[] => steps.filter((step) => !step.stepKey || !BOOKKEEPING.test(step.stepKey));

export const isContinuousRun = (allSteps: ReadonlyArray<{ stepKey?: string; startedAt: Date; endedAt: Date }>): boolean => {
  const steps = workSteps(allSteps);
  const ordered = [...steps].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  let latestEnd = ordered[0]?.endedAt.getTime() ?? 0;
  for (const step of ordered.slice(1)) {
    if ((step.startedAt.getTime() - latestEnd) / 1000 > PAUSE_GAP_SEC) return false;
    latestEnd = Math.max(latestEnd, step.endedAt.getTime());
  }
  return true;
};

/**
 * End-to-end (accepted -> MP4 ready) for first-attempt, continuous runs only: a retried or paused run's clock includes failures and
 * operator waits, which says nothing about steady-state latency. Also reports the Creatomate render time on its own
 * (provider `render_duration`, else submittedAt -> completedAt) and how many runs were excluded.
 */
export const endToEnd = (
  runs: readonly RunSample[],
): { endToEndSec: Stat; activeSec: Stat; pipelineSec: Stat; queueWaitSec: Stat; renderSec: Stat; withinTargetRatio: number | null; activeWithinTargetRatio: number | null; considered: number; excluded: number } => {
  const rendered = runs.filter((run) => run.renderedAt);
  const clean = rendered.filter((run) => run.attempts === 1 && isContinuousRun(run.steps));
  const total = clean.map((run) => (run.renderedAt!.getTime() - run.createdAt.getTime()) / 1000);
  // Active = first step start -> MP4 ready (what the pipeline itself costs); queue wait = created -> first step start (load/worker availability).
  const firstStart = (run: RunSample) => workSteps(run.steps).reduce<number | null>((min, step) => (min === null || step.startedAt.getTime() < min ? step.startedAt.getTime() : min), null);
  const active = clean.flatMap((run) => { const start = firstStart(run); return start === null ? [] : [(run.renderedAt!.getTime() - start) / 1000]; });
  // Pipeline = first work step start -> end of `submit_render` (script, voice, media, timeline, submit). Unlike `renderedAt` it never depends on a
  // webhook/poll arriving, so it is the trustworthy part of the dev-DB numbers.
  const pipeline = clean.flatMap((run) => {
    const start = firstStart(run);
    const submitted = run.steps.find((step) => step.stepKey === "submit_render");
    return start === null || !submitted ? [] : [(submitted.endedAt.getTime() - start) / 1000];
  });
  const queueWait = clean.flatMap((run) => { const start = firstStart(run); return start === null ? [] : [Math.max(0, (start - run.createdAt.getTime()) / 1000)]; });
  const render = clean
    .map((run) => (run.renderDurationMs !== null ? run.renderDurationMs / 1000 : run.renderSubmittedAt ? (run.renderedAt!.getTime() - run.renderSubmittedAt.getTime()) / 1000 : null))
    .filter((v): v is number => v !== null && v >= 0);
  return {
    endToEndSec: toStat(total),
    activeSec: toStat(active),
    pipelineSec: toStat(pipeline),
    queueWaitSec: toStat(queueWait),
    renderSec: toStat(render),
    withinTargetRatio: total.length === 0 ? null : total.filter((s) => s < 300).length / total.length,
    activeWithinTargetRatio: active.length === 0 ? null : active.filter((s) => s < 300).length / active.length,
    considered: clean.length,
    excluded: rendered.length - clean.length,
  };
};

/** Little's law: average runs in flight needed to sustain `perHour` videos/hour at `latencySec` per video. */
export const requiredConcurrency = (perHour: number, latencySec: number): number => Math.ceil((perHour / 3600) * latencySec);

/** Slots a provider needs so `burst` simultaneous videos each finish that step within `windowSec`, given `callsPerVideo` calls of `callSec` each. */
export const requiredProviderSlots = (burst: number, callsPerVideo: number, callSec: number, windowSec: number): number => Math.ceil((burst * callsPerVideo * callSec) / windowSec);
