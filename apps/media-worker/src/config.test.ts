import { describe, expect, it } from "vitest";
import { loadMediaWorkerConfig, MediaWorkerConfigError } from "./config.js";

/** VE2E-134: per-job-type queues + prefetch; unset env keeps the old single-prefetch behaviour. */
describe("loadMediaWorkerConfig per-type queues/prefetch", () => {
  it("defaults: legacy queue + derived split queues, every type uses the old shared prefetch, compose defers to its own config", () => {
    const cfg = loadMediaWorkerConfig({ RABBITMQ_URL: "amqp://x" }, "/repo", 8);
    expect(cfg.queue).toBe("lyonix.media");
    expect(cfg.queues).toEqual({ clipPrepare: "lyonix.media", frameExtract: "lyonix.media.frame", reframeAnalyze: "lyonix.media.reframe" });
    expect(cfg.prefetch).toBe(3);
    expect(cfg.prefetchByType).toEqual({ clipPrepare: 3, frameExtract: 3, reframeAnalyze: 3, compose: null });
  });

  it("MEDIA_WORKER_PREFETCH_<TYPE> overrides one type, capped at the CPU count; the shared default feeds the rest", () => {
    const cfg = loadMediaWorkerConfig({ MEDIA_WORKER_PREFETCH: "2", MEDIA_WORKER_PREFETCH_CLIP_PREPARE: "6", MEDIA_WORKER_PREFETCH_REFRAME_ANALYZE: "1", MEDIA_WORKER_PREFETCH_COMPOSE: "2" }, "/repo", 4);
    expect(cfg.prefetchByType).toEqual({ clipPrepare: 4, frameExtract: 2, reframeAnalyze: 1, compose: 2 });
  });

  it("custom queue names and validation", () => {
    const cfg = loadMediaWorkerConfig({ MEDIA_WORKER_QUEUE: "m", MEDIA_WORKER_QUEUE_FRAME: "fr" }, "/repo", 4);
    expect(cfg.queues).toEqual({ clipPrepare: "m", frameExtract: "fr", reframeAnalyze: "m.reframe" });
    expect(() => loadMediaWorkerConfig({ MEDIA_WORKER_PREFETCH_FRAME_EXTRACT: "0" }, "/repo", 4)).toThrow(MediaWorkerConfigError);
  });
});
