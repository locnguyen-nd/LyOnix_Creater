/**
 * Groups the Auto DAG's raw step events (`GET /video-productions/:id/events`) into the five
 * user-facing stages shown by the Video Auto timeline. Pure presentation logic: it reads the
 * existing event/run payloads and never changes what the server does.
 */
import type { WorkflowRunStatus, WorkflowStepEventResponse } from "@lyonix/contracts";

export const STAGE_KEYS = ["script", "voice", "keywords", "media", "render"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageStatus = "pending" | "running" | "done" | "failed";

export type StageSummary = {
  key: StageKey;
  status: StageStatus;
  /** Epoch ms; null while the stage has not started. */
  startMs: number | null;
  /** Epoch ms of the last finished step (or "now" while running); null while pending. */
  endMs: number | null;
  stepsDone: number;
  stepsTotal: number;
};

/** Translucent so the same fill reads on both the light and the dark theme. */
export const STAGE_COLORS: Record<StageKey, string> = {
  script: "rgba(99,102,241,0.38)",
  voice: "rgba(234,179,8,0.42)",
  keywords: "rgba(236,72,153,0.34)",
  media: "rgba(16,185,129,0.40)",
  render: "rgba(59,130,246,0.40)",
};

export function stageOfStep(stepKey: string): StageKey | null {
  // Bookkeeping steps (`*_diagnostics`, `duration_budget`, `run_usage`) are rewritten later in the run (e.g. on resume), so their
  // start/end span minutes and would stretch a stage; only real work steps place a stage on the timeline.
  if (stepKey === "extract_keywords" || stepKey === "keywords_from_script") return "keywords";
  if (stepKey.startsWith("generate_audio")) return "voice";
  if (stepKey.startsWith("import_media")) return "media";
  if (stepKey === "persist_timeline_version" || stepKey === "submit_render") return "render";
  if (
    stepKey === "reuse_or_generate_script" || stepKey === "generate_script" ||
    stepKey === "persist_script_version" || stepKey === "approve_script_version"
  ) return "script";
  return null;
}

const RENDER_PHASE: ReadonlySet<WorkflowRunStatus> = new Set(["render_queued", "rendering", "verifying", "reconciling"]);
const TERMINAL: ReadonlySet<WorkflowRunStatus> = new Set(["completed", "failed", "cancelled"]);

export const isTerminalRun = (status: WorkflowRunStatus) => TERMINAL.has(status);

const ms = (iso: string | null) => (iso ? Date.parse(iso) : null);

export function summarizeStages(
  events: readonly WorkflowStepEventResponse[],
  run: { status: WorkflowRunStatus; updatedAt: string },
  nowMs: number,
): StageSummary[] {
  // Only the latest attempt of each step counts (a retried step replaces its earlier failed attempt).
  const latest = new Map<string, WorkflowStepEventResponse>();
  for (const event of events) {
    const current = latest.get(event.stepKey);
    if (!current || event.attempt >= current.attempt) latest.set(event.stepKey, event);
  }
  const buckets = new Map<StageKey, WorkflowStepEventResponse[]>();
  for (const event of latest.values()) {
    const stage = stageOfStep(event.stepKey);
    if (stage) buckets.set(stage, [...(buckets.get(stage) ?? []), event]);
  }

  const summaries: StageSummary[] = STAGE_KEYS.map((key) => {
    const list = buckets.get(key) ?? [];
    const starts = list.map((e) => ms(e.startedAt)).filter((v): v is number => v !== null);
    const ends = list.map((e) => ms(e.endedAt)).filter((v): v is number => v !== null);
    const stepsDone = list.filter((e) => e.status === "succeeded" || e.status === "skipped").length;
    const failed = list.some((e) => e.status === "failed");
    const running = list.some((e) => e.status === "running");
    const started = starts.length > 0;
    const startMs = started ? Math.min(...starts) : null;
    let status: StageStatus = "pending";
    if (failed) status = "failed";
    else if (running) status = "running";
    else if (list.length > 0 && stepsDone === list.length) status = "done";
    else if (started) status = "running";
    const endMs = status === "running" ? nowMs : ends.length > 0 ? Math.max(...ends) : startMs;
    return { key, status, startMs, endMs: started ? endMs : null, stepsDone, stepsTotal: list.length };
  });

  // A stage whose steps are all finished is only "done" if nothing after it is still pending-in-progress.
  // Render: once its persist/submit steps succeeded, the remaining time is the provider render itself.
  const render = summaries[4]!;
  const renderSubmitted = render.status === "done";
  if (renderSubmitted || (render.status === "pending" && RENDER_PHASE.has(run.status))) {
    if (run.status === "completed") {
      render.status = "done";
      render.endMs = ms(run.updatedAt) ?? render.endMs;
    } else if (RENDER_PHASE.has(run.status)) {
      render.status = "running";
      render.endMs = nowMs;
    }
    render.startMs ??= render.endMs;
  }
  if (run.status === "failed" || run.status === "cancelled") {
    const running = summaries.find((s) => s.status === "running");
    if (running) running.status = "failed";
  }
  return summaries;
}

/** The stage the run is in right now: the running/failed one, else the last finished, else the first. */
export function currentStage(stages: readonly StageSummary[]): StageSummary {
  return stages.find((s) => s.status === "running" || s.status === "failed") ?? [...stages].reverse().find((s) => s.status === "done") ?? stages[0]!;
}

export function formatElapsed(totalMs: number): string {
  const seconds = Math.max(0, Math.round(totalMs / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}
