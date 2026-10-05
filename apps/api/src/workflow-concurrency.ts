/** Auto runs the workflow worker keeps in flight at once (each run is one video). Env `WORKFLOW_CONCURRENCY`, default 5, clamped to 1..10. */
export const DEFAULT_WORKFLOW_CONCURRENCY = 5;
export const MAX_WORKFLOW_CONCURRENCY = 10;

export const resolveWorkflowConcurrency = (env: Record<string, string | undefined> = process.env): number => {
  const raw = env.WORKFLOW_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_WORKFLOW_CONCURRENCY;
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 1) return DEFAULT_WORKFLOW_CONCURRENCY;
  return Math.min(MAX_WORKFLOW_CONCURRENCY, value);
};

/**
 * Keeps up to `limit` started runs in flight. `start` claims the next run and returns a `{ done }` handle (NOT a bare
 * promise: an async function would wait for it), or `null` when nothing is queued. Returns how many runs this call
 * started; finished runs free their slot automatically.
 */
export async function fillWorkflowSlots(inflight: Set<Promise<void>>, limit: number, start: () => Promise<{ done: Promise<void> } | null>): Promise<number> {
  let started = 0;
  while (inflight.size < limit) {
    const handle = await start();
    if (!handle) break;
    const tracked: Promise<void> = handle.done.finally(() => { inflight.delete(tracked); });
    inflight.add(tracked);
    started += 1;
  }
  return started;
}
