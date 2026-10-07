/**
 * VE2E-133 (what is and is not shared between concurrent runs; recommended ceiling is NOT fixed here until measured):
 * - Per run (never shared): `SegmentSourceLedger`, `ApifyJobContext`, the media/voice branch promises, the `run_usage` append chain.
 * - Shared on purpose, process-wide: the provider limiter (`getSharedProviderLimiter`: content, elevenlabs, apify, creatomate, ...), which
 *   is the real ceiling on provider calls however many runs are in flight. Each run now holds up to
 *   `WORKFLOW_VOICE_PARALLELISM` TTS calls plus `MEDIA_PLAN_SOURCING_CONCURRENCY` (3) segment searches at the same time (the two
 *   branches overlap), so the per-run peak of local CPU/IO work (image/ONNX reframe in media sourcing + TTS I/O) is higher than before.
 * - Raise `WORKFLOW_CONCURRENCY` only together with `PROVIDER_CONCURRENCY_*`; the recommended maximum is taken from the VE2E-119
 *   measurement (p95 run time from claim to `render_queued` stays under the 300 s SLO, no `apify_queue_timeout`/RATE_LIMITED rise in
 *   `pnpm report:failures`), not from this comment.
 */
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
