import { describe, expect, it } from "vitest";
import { MediaJobClient } from "./client.js";
import { isMediaQueueSplitEnabled, resolveProducerQueues, splitMediaJobQueueNames } from "./queues.js";
import { InMemoryMediaJobBroker } from "./testing.js";

/** VE2E-134: per-type queue routing; legacy names/behaviour stay the default. */
describe("media job queue names", () => {
  it("derives split names from the legacy queue; clip.prepare keeps the legacy name, compose the render queue", () => {
    expect(splitMediaJobQueueNames({})).toEqual({ clip_prepare: "lyonix.media", frame_extract: "lyonix.media.frame", reframe_analyze: "lyonix.media.reframe", compose: "lyonix.render" });
    expect(splitMediaJobQueueNames({ MEDIA_WORKER_QUEUE: "q", MEDIA_WORKER_QUEUE_FRAME: "f", MEDIA_WORKER_RENDER_QUEUE: "r" })).toEqual({ clip_prepare: "q", frame_extract: "f", reframe_analyze: "q.reframe", compose: "r" });
  });

  it("producers route everything but compose to the legacy queue unless the split is on", () => {
    const names = splitMediaJobQueueNames({});
    expect(resolveProducerQueues(names, false)).toEqual({ ...names, frame_extract: "lyonix.media", reframe_analyze: "lyonix.media" });
    expect(resolveProducerQueues(names, true)).toEqual(names);
    expect(isMediaQueueSplitEnabled(undefined)).toBe(false);
    expect(isMediaQueueSplitEnabled("0")).toBe(false);
    expect(isMediaQueueSplitEnabled(" 1 ")).toBe(true);
  });
});

describe("MediaJobClient queue routing", () => {
  const frameInput = { jobKey: "frames:t1", source: { relativePath: "projects/p/assets/a.mp4", mediaAssetVersionId: "mav-1" }, frameCount: 3 };
  const reframeInput = { jobKey: "reframe:t1", source: { relativePath: "projects/p/assets/a.mp4", mediaAssetVersionId: "mav-1", kind: "video" as const }, startMs: 0, durationMs: 3000, origin: "apify", preferredSubject: null };
  const clipInput = { jobKey: "clip:t1", source: { relativePath: "projects/p/assets/a.mp4", mediaAssetVersionId: "mav-1" }, startMs: 0, durationMs: 3000, stripAudio: true };

  const publishedQueues = async (splitQueues: boolean | undefined) => {
    const broker = new InMemoryMediaJobBroker();
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: "lm", splitQueues, defaultTimeoutMs: 50 });
    await Promise.allSettled([client.prepareClip(clipInput, { timeoutMs: 30 }), client.extractFrames(frameInput, { timeoutMs: 30 }), client.analyzeReframe(reframeInput, { timeoutMs: 30 })]);
    return Object.fromEntries(broker.published.filter((p) => p.options.type).map((p) => [p.options.type!, p.queue]));
  };

  it("default (no split): every job type goes to the legacy queue, exactly as before", async () => {
    expect(await publishedQueues(undefined)).toEqual({ "clip.prepare": "lm", "frame.extract": "lm", "reframe.analyze": "lm" });
  });

  it("split on: clip.prepare stays on the legacy queue, frame.extract/reframe.analyze use their own (declared lazily)", async () => {
    expect(await publishedQueues(true)).toEqual({ "clip.prepare": "lm", "frame.extract": "lm.frame", "reframe.analyze": "lm.reframe" });
  });
});
