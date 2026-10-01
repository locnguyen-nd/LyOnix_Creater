/**
 * VE2E-62: pure display helpers for the queue state the API derives (`queuePosition`, `queuedAt`, `QueueSummaryResponse`).
 * No React, no I/O - the pages poll and render, these decide what to show.
 */
import type { QueueStateFields, QueueSummaryResponse, WorkflowRunStatus } from "@lyonix/contracts";

/** Runs that can still change on their own, so a list/detail view should keep refreshing. */
const SETTLED_STATUSES: readonly WorkflowRunStatus[] = ["completed", "failed", "cancelled", "blocked_provider", "needs_input"];

export const isSettledRun = (status: WorkflowRunStatus): boolean => SETTLED_STATUSES.includes(status);

export const hasLiveRuns = (rows: ReadonlyArray<{ status: WorkflowRunStatus }>): boolean => rows.some((row) => !isSettledRun(row.status));

/** Only a run that is `draft` and ranked is waiting; any other state is running or finished. */
export const isWaitingInQueue = (status: WorkflowRunStatus, queue: Pick<QueueStateFields, "queuePosition"> | null | undefined): boolean =>
  status === "draft" && typeof queue?.queuePosition === "number";

/** "45s", "3m 05s", "1h 02m" - locale-neutral, null when the start is unknown or in the future. */
export function formatWaited(since: string | null | undefined, nowMs: number): string | null {
  if (!since) return null;
  const startMs = Date.parse(since);
  if (!Number.isFinite(startMs) || startMs > nowMs) return null;
  const totalSeconds = Math.floor((nowMs - startMs) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Summary for one queue kind, or null when the API returned nothing for it. */
export const queueOfKind = (summary: readonly QueueSummaryResponse[], kind: QueueSummaryResponse["kind"]): QueueSummaryResponse | null =>
  summary.find((item) => item.kind === kind) ?? null;

/** True when the queue is saturated: every slot busy AND something waiting - the moment "đang chờ" is expected rather than a stall. */
export const isQueueSaturated = (item: Pick<QueueSummaryResponse, "active" | "limit" | "queued">): boolean => item.limit > 0 && item.active >= item.limit && item.queued > 0;
