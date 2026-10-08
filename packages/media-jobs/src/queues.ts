import { DEFAULT_MEDIA_WORKER_QUEUE } from "./contract.js";
import { DEFAULT_RENDER_QUEUE } from "./compose-contract.js";

/**
 * VE2E-134 (CR-MEDIA-SLA section 3.4): per-job-type queues so a heavy job type never blocks the others (render 1080p60 vs clip.prepare).
 *
 * Backward compatible by construction:
 * - `clip.prepare` ALWAYS stays on the legacy queue name (`MEDIA_WORKER_QUEUE`, default `lyonix.media`) and `video.compose` on the render queue.
 * - `frame.extract` / `reframe.analyze` move to `<queue>.frame` / `<queue>.reframe` ONLY when the producer enables the split
 *   (`MEDIA_QUEUE_SPLIT=1`); with the split off every type goes to the legacy queue exactly as before.
 * - A new worker always consumes the legacy queue (all job types) AND the split queues, so messages published by an old API, or left over
 *   before the switch, are still served. Roll out: upgrade all workers first, then set `MEDIA_QUEUE_SPLIT=1` on the API.
 */
export type MediaJobQueueType = "clip_prepare" | "frame_extract" | "reframe_analyze" | "compose";

export type MediaJobQueueNames = Record<MediaJobQueueType, string>;

export const MEDIA_QUEUE_FRAME_SUFFIX = ".frame";
export const MEDIA_QUEUE_REFRAME_SUFFIX = ".reframe";

export const isMediaQueueSplitEnabled = (value: string | undefined): boolean => ["1", "true", "on", "yes"].includes((value ?? "").trim().toLowerCase());

/** Names of the split queues (always derivable, whether or not the producer routes to them). */
export const splitMediaJobQueueNames = (env: {
  MEDIA_WORKER_QUEUE?: string | undefined;
  MEDIA_WORKER_QUEUE_FRAME?: string | undefined;
  MEDIA_WORKER_QUEUE_REFRAME?: string | undefined;
  MEDIA_WORKER_RENDER_QUEUE?: string | undefined;
}): MediaJobQueueNames => {
  const base = env.MEDIA_WORKER_QUEUE?.trim() || DEFAULT_MEDIA_WORKER_QUEUE;
  return {
    clip_prepare: base,
    frame_extract: env.MEDIA_WORKER_QUEUE_FRAME?.trim() || `${base}${MEDIA_QUEUE_FRAME_SUFFIX}`,
    reframe_analyze: env.MEDIA_WORKER_QUEUE_REFRAME?.trim() || `${base}${MEDIA_QUEUE_REFRAME_SUFFIX}`,
    compose: env.MEDIA_WORKER_RENDER_QUEUE?.trim() || DEFAULT_RENDER_QUEUE,
  };
};

/** Where a PRODUCER sends each job type: the split names when enabled, else everything but compose on the legacy queue. */
export const resolveProducerQueues = (names: MediaJobQueueNames, split: boolean): MediaJobQueueNames =>
  split ? names : { ...names, frame_extract: names.clip_prepare, reframe_analyze: names.clip_prepare };
