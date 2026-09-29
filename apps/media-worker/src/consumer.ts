import {
  assertMediaJobQueue,
  CLIP_PREPARE_JOB_TYPE,
  CLIP_PREPARE_RESULT_TYPE,
  MEDIA_JOB_SCHEMA_VERSION,
  type ClipPrepareResult,
  type MediaJobChannel,
  type MediaJobMessage,
} from "@lyonix/media-jobs";
import { JobLockBusyError, type ClipPrepareProcessor } from "./clip-prepare.js";

export type ConsumerHandle = {
  /** Stop taking new work: later deliveries are nacked+requeued for another worker/restart. */
  stop(): void;
  /** Resolves when every in-flight message has been settled. */
  drain(): Promise<void>;
};

/**
 * Wires `ClipPrepareProcessor` to the media queue: parse -> process -> publish result to
 * `replyTo` with the same `correlationId` -> ack. Poison messages (bad JSON / unknown
 * type / invalid job) get an INVALID_JOB result and are acked, never requeued forever.
 * A job locked by another process is nacked+requeued after `lockRetryDelayMs`.
 */
export async function startClipPrepareConsumer(input: {
  channel: MediaJobChannel;
  queue: string;
  prefetch: number;
  processor: ClipPrepareProcessor;
  lockRetryDelayMs?: number;
  log?: (message: string) => void;
}): Promise<ConsumerHandle> {
  const { channel, processor } = input;
  const log = input.log ?? (() => undefined);
  const lockRetryDelayMs = input.lockRetryDelayMs ?? 2_000;
  const inflight = new Set<Promise<void>>();
  let stopping = false;

  await assertMediaJobQueue(channel, input.queue);
  await channel.prefetch(input.prefetch);

  const reply = (message: MediaJobMessage, result: ClipPrepareResult) => {
    const { replyTo, correlationId } = message.properties;
    if (!replyTo) {
      log(`clip.prepare ${result.jobKey}: no replyTo; result kept in idempotency store only`);
      return;
    }
    channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(result)), {
      contentType: "application/json",
      type: CLIP_PREPARE_RESULT_TYPE,
      ...(correlationId ? { correlationId } : {}),
    });
  };

  const invalid = (jobKey: string, message: string): ClipPrepareResult => ({
    schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
    type: CLIP_PREPARE_RESULT_TYPE,
    ok: false,
    jobKey,
    error: { code: "INVALID_JOB", message, retryable: false, attempts: 0 },
    completedAt: new Date().toISOString(),
  });

  const handle = async (message: MediaJobMessage) => {
    let body: unknown;
    try {
      body = JSON.parse(message.content.toString("utf8"));
    } catch {
      reply(message, invalid(message.properties.messageId ?? "invalid", "message body is not JSON"));
      channel.ack(message);
      return;
    }
    const type = (body as { type?: unknown } | null)?.type;
    if (type !== CLIP_PREPARE_JOB_TYPE) {
      reply(message, invalid(message.properties.messageId ?? "invalid", `unsupported media job type ${String(type)}`));
      channel.ack(message);
      return;
    }
    try {
      const result = await processor.handle(body);
      log(
        result.ok
          ? `clip.prepare ${result.jobKey} ok mode=${result.mode} reused=${result.reused} bytes=${result.output.bytes} driftStart=${result.drift.startMs}ms driftDuration=${result.drift.durationMs}ms`
          : `clip.prepare ${result.jobKey} failed ${result.error.code}: ${result.error.message}`,
      );
      reply(message, result);
      channel.ack(message);
    } catch (error) {
      if (error instanceof JobLockBusyError) {
        setTimeout(() => channel.nack(message, false, true), lockRetryDelayMs);
        return;
      }
      const jobKey = typeof (body as { jobKey?: unknown }).jobKey === "string" ? (body as { jobKey: string }).jobKey : "invalid";
      reply(message, {
        schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
        type: CLIP_PREPARE_RESULT_TYPE,
        ok: false,
        jobKey,
        error: { code: "INTERNAL", message: error instanceof Error ? error.message : "unknown error", retryable: true, attempts: 0 },
        completedAt: new Date().toISOString(),
      });
      channel.ack(message);
    }
  };

  await channel.consume(input.queue, (message) => {
    if (!message) return;
    if (stopping) {
      channel.nack(message, false, true);
      return;
    }
    const task = handle(message).finally(() => inflight.delete(task));
    inflight.add(task);
  });

  return {
    stop() {
      stopping = true;
    },
    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
