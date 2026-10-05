import { describe, expect, it } from "vitest";
import { MediaJobClient } from "./client.js";
import { CLIP_PREPARE_RESULT_TYPE, MEDIA_JOB_SCHEMA_VERSION, MediaJobClientError, type ClipPrepareJob, type ClipPrepareResult } from "./contract.js";
import { InMemoryMediaJobBroker } from "./testing.js";

const QUEUE = "lyonix.media.test";

const jobInput = (jobKey: string) => ({
  jobKey,
  source: { relativePath: "projects/p/assets/a.mp4", mediaAssetVersionId: "mav" },
  startMs: 0,
  durationMs: 3000,
  stripAudio: true,
});

const failureFor = (jobKey: string): ClipPrepareResult => ({
  schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
  type: CLIP_PREPARE_RESULT_TYPE,
  ok: false,
  jobKey,
  error: { code: "SOURCE_NOT_FOUND", message: "missing", retryable: false, attempts: 1 },
  completedAt: new Date(0).toISOString(),
});

/** Minimal echo worker on the in-memory broker: replies to replyTo with correlationId. */
const startEchoWorker = async (broker: InMemoryMediaJobBroker, respond: (job: ClipPrepareJob) => ClipPrepareResult | null = (job) => failureFor(job.jobKey)) => {
  const channel = broker.createChannel();
  await channel.assertQueue(QUEUE);
  const seen: Array<{ job: ClipPrepareJob; correlationId?: string | undefined; messageId?: string | undefined }> = [];
  await channel.consume(QUEUE, (message) => {
    if (!message) return;
    const job = JSON.parse(message.content.toString()) as ClipPrepareJob;
    seen.push({ job, correlationId: message.properties.correlationId, messageId: message.properties.messageId });
    const result = respond(job);
    if (result && message.properties.replyTo) {
      channel.sendToQueue(message.properties.replyTo, Buffer.from(JSON.stringify(result)), {
        ...(message.properties.correlationId ? { correlationId: message.properties.correlationId } : {}),
      });
    }
    channel.ack(message);
  });
  return { channel, seen };
};

describe("MediaJobClient (enqueue + await over RabbitMQ RPC)", () => {
  it("fails fast with MEDIA_WORKER_NOT_CONFIGURED when RABBITMQ_URL is missing", async () => {
    await expect(MediaJobClient.connect({ url: undefined })).rejects.toMatchObject({ code: "MEDIA_WORKER_NOT_CONFIGURED" });
    await expect(MediaJobClient.connect({ url: "  " })).rejects.toBeInstanceOf(MediaJobClientError);
  });

  it("publishes a persistent job with correlationId/replyTo/messageId=jobKey and resolves with the correlated result", async () => {
    const broker = new InMemoryMediaJobBroker();
    const worker = await startEchoWorker(broker);
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: QUEUE });
    const result = await client.prepareClip(jobInput("clip:one"), { timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, jobKey: "clip:one", error: { code: "SOURCE_NOT_FOUND" } });
    expect(worker.seen[0]?.messageId).toBe("clip:one");
    expect(worker.seen[0]?.job.target).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264" });
    const published = broker.published.find((p) => p.queue === QUEUE)!;
    expect(published.options).toMatchObject({ persistent: true, type: "clip.prepare", expiration: "1000" });
    expect(client.inFlight).toBe(0);
  });

  it("routes concurrent results to the right caller by correlationId even when replies arrive out of order", async () => {
    const broker = new InMemoryMediaJobBroker();
    const held: Array<() => void> = [];
    const channel = broker.createChannel();
    await channel.assertQueue(QUEUE);
    await channel.consume(QUEUE, (message) => {
      if (!message) return;
      const job = JSON.parse(message.content.toString()) as ClipPrepareJob;
      held.push(() =>
        channel.sendToQueue(message.properties.replyTo!, Buffer.from(JSON.stringify(failureFor(job.jobKey))), { correlationId: message.properties.correlationId! }),
      );
      channel.ack(message);
    });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: QUEUE });
    const a = client.prepareClip(jobInput("clip:a"), { timeoutMs: 1000 });
    const b = client.prepareClip(jobInput("clip:b"), { timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    expect(held).toHaveLength(2);
    held[1]!();
    held[0]!();
    await expect(a).resolves.toMatchObject({ jobKey: "clip:a" });
    await expect(b).resolves.toMatchObject({ jobKey: "clip:b" });
  });

  it("rejects with RESULT_TIMEOUT when no result arrives, and ignores the late reply", async () => {
    const broker = new InMemoryMediaJobBroker();
    let late: (() => void) | null = null;
    const channel = broker.createChannel();
    await channel.assertQueue(QUEUE);
    await channel.consume(QUEUE, (message) => {
      if (!message) return;
      late = () => channel.sendToQueue(message.properties.replyTo!, Buffer.from(JSON.stringify(failureFor("clip:slow"))), { correlationId: message.properties.correlationId! });
      channel.ack(message);
    });
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: QUEUE });
    await expect(client.prepareClip(jobInput("clip:slow"), { timeoutMs: 30 })).rejects.toMatchObject({ code: "RESULT_TIMEOUT" });
    expect(client.inFlight).toBe(0);
    expect(late).not.toBeNull();
    late!();
    await new Promise((r) => setTimeout(r, 5));
    expect(client.inFlight).toBe(0);
  });

  it("rejects invalid jobs before publishing", async () => {
    const broker = new InMemoryMediaJobBroker();
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: QUEUE });
    await expect(client.prepareClip({ ...jobInput("clip:x"), source: { relativePath: "../x.mp4" } })).rejects.toMatchObject({ code: "INVALID_JOB" });
    expect(broker.published.filter((p) => p.queue === QUEUE)).toHaveLength(0);
  });

  it("rejects a malformed or mismatched result as INVALID_RESULT", async () => {
    const broker = new InMemoryMediaJobBroker();
    await startEchoWorker(broker, (job) => ({ ...failureFor(job.jobKey), jobKey: "someone-else" }));
    const client = await MediaJobClient.create({ channel: broker.createChannel(), queue: QUEUE });
    await expect(client.prepareClip(jobInput("clip:m"), { timeoutMs: 500 })).rejects.toMatchObject({ code: "INVALID_RESULT" });
  });

  it("fails pending calls with BROKER_UNAVAILABLE when the channel closes, and after close()", async () => {
    const broker = new InMemoryMediaJobBroker();
    await startEchoWorker(broker, () => null);
    const channel = broker.createChannel();
    const client = await MediaJobClient.create({ channel, queue: QUEUE });
    const pending = client.prepareClip(jobInput("clip:c"), { timeoutMs: 5000 });
    await channel.close();
    await expect(pending).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
    await client.close();
    await expect(client.prepareClip(jobInput("clip:d"))).rejects.toMatchObject({ code: "BROKER_UNAVAILABLE" });
  });
});
