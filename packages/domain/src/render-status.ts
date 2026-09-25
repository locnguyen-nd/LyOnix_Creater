/**
 * VE2E-05: monotonic render lifecycle guard. Creatomate delivers status via webhook
 * (may arrive duplicated or out-of-order) and via poll/reconcile fallback. Neither
 * source is trusted to be authoritative-in-order, so every incoming status update is
 * passed through `nextRenderJobStatus` before being written — it never lets a render
 * regress from a later stage to an earlier one, and once a terminal status is reached
 * it is final (idempotent against replays).
 */

export const renderJobStatuses = [
  "accepted",
  "queued",
  "rendering",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "reconciling",
  "blocked_provider",
] as const;
export type RenderJobStatus = (typeof renderJobStatuses)[number];

const TERMINAL: ReadonlySet<RenderJobStatus> = new Set(["completed", "failed", "cancelled"]);

/** Progress rank for the non-terminal, non-side-band statuses only. */
const PROGRESS_RANK: Record<string, number> = {
  accepted: 0,
  queued: 1,
  rendering: 2,
  verifying: 3,
};

export const isTerminalRenderStatus = (status: RenderJobStatus): boolean => TERMINAL.has(status);

/**
 * Returns the status that should actually be written given the current persisted
 * status and an incoming one, or `null` when the incoming update must be ignored
 * (regression / stale replay after a terminal state was already reached).
 *
 * Rules:
 * - Once `current` is terminal (`completed|failed|cancelled`), every further update
 *   is ignored — renders never un-complete or un-fail.
 * - A terminal `incoming` always wins over a non-terminal `current`.
 * - `blocked_provider`/`reconciling` are side-bands that may be entered from any
 *   non-terminal progress stage (they do not themselves have forward progress).
 * - Among the ordered progress stages (`accepted < queued < rendering < verifying`),
 *   only forward or equal-rank moves are applied — a `queued` arriving after
 *   `rendering` was already recorded is a stale/out-of-order webhook and is dropped.
 */
export const nextRenderJobStatus = (current: RenderJobStatus, incoming: RenderJobStatus): RenderJobStatus | null => {
  if (isTerminalRenderStatus(current)) return null;
  if (isTerminalRenderStatus(incoming)) return incoming;
  if (incoming === "blocked_provider" || incoming === "reconciling") return incoming;
  if (current === "blocked_provider" || current === "reconciling") {
    // Leaving a side-band forward into a progress stage is allowed; do not compare ranks against the side-band itself.
    return incoming in PROGRESS_RANK ? incoming : null;
  }
  const currentRank = PROGRESS_RANK[current] ?? -1;
  const incomingRank = PROGRESS_RANK[incoming] ?? -1;
  if (incomingRank < currentRank) return null;
  return incoming;
};
