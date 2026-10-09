import {
  assertMediaJobQueue,
  MEDIA_JOB_SCHEMA_VERSION,
  VIDEO_COMPOSE_JOB_TYPE,
  VIDEO_COMPOSE_PROGRESS_TYPE,
  VIDEO_COMPOSE_RESULT_TYPE,
  type MediaJobChannel,
  type MediaJobMessage,
  type VideoComposeResult,
} from "@lyonix/media-jobs";
import type { ConsumerHandle } from "../consumer.js";
import { JobLockBusyError } from "../job-errors.js";
import type { ComposeProcessor } from "./compose-processor.js";

/**
 * VE2E-105: wires the compose processor to the render queue (`lyonix.render`): parse -> process -> publish `video.compose.progress`
 * messages and finally one `video.compose.result` to `replyTo` with the same `correlationId` -> ack. Poison messages (bad JSON / wrong
 * type / invalid job) get an INVALID_JOB result and are acked, never requeued forever. A job locked by another process is requeued
 * after `lockRetryDelayMs`.
 */
export async function startComposeConsumer(input: {
  channel: MediaJobChannel;
  queue: string;
  prefetch: number;
  processor: ComposeProcessor;
  lockRetryDelayMs?: number;
  log?: (message: string) => void;
}): Promise<ConsumerHandle> {
  const { channel, processor } = input;
  const log = input.log ?? (() => undefined);
  const lockRetryDelayMs = input.lockRetryDelayMs ?? 5_000;
  const inflight = new Set<Promise<void>>();
  let stopping = false;

  await assertMediaJobQueue(channel, input.queue);
  await channel.prefetch(input.prefetch);

  const publish = (message: MediaJobMessage, type: string, body: unknown) => {
    const { replyTo, correlationId } = message.properties;
    if (!replyTo) return;
    channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(body)), { contentType: "application/json", type, ...(correlationId ? { correlationId } : {}) });
  };

  const invalid = (jobKey: string, text: string): VideoComposeResult => ({
    schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
    type: VIDEO_COMPOSE_RESULT_TYPE,
    ok: false,
    jobKey,
    error: { code: "INVALID_JOB", message: text, retryable: false, attempts: 0 },
    completedAt: new Date().toISOString(),
  });

  const handle = async (message: MediaJobMessage) => {
    let body: unknown;
    try {
      body = JSON.parse(message.content.toString("utf8"));
    } catch {
      publish(message, VIDEO_COMPOSE_RESULT_TYPE, invalid(message.properties.messageId ?? "invalid", "message body is not JSON"));
      channel.ack(message);
      return;
    }
    const jobKey = typeof (body as { jobKey?: unknown } | null)?.jobKey === "string" ? (body as { jobKey: string }).jobKey : "invalid";
    if ((body as { type?: unknown } | null)?.type !== VIDEO_COMPOSE_JOB_TYPE) {
      publish(message, VIDEO_COMPOSE_RESULT_TYPE, invalid(jobKey, `unsupported job type on the render queue: ${String((body as { type?: unknown } | null)?.type)}`));
      channel.ack(message);
      return;
    }
    try {
      const result = await processor.handle(body, (progress) => publish(message, VIDEO_COMPOSE_PROGRESS_TYPE, progress));
      log(
        result.ok
          ? `video.compose ${result.jobKey} ok reused=${result.reused} bytes=${result.output.bytes} renderMs=${result.metrics.renderMs} cpu=${result.metrics.cpuSeconds ?? "n/a"}s qc=${result.qc.passed ? "pass" : "fail"} stagesMs=${JSON.stringify(result.metrics.stagesMs ?? {})}`
          : `video.compose ${result.jobKey} failed ${result.error.code}: ${result.error.message}`,
      );
      publish(message, VIDEO_COMPOSE_RESULT_TYPE, result);
      channel.ack(message);
    } catch (error) {
      if (error instanceof JobLockBusyError) {
        setTimeout(() => channel.nack(message, false, true), lockRetryDelayMs);
        return;
      }
      publish(message, VIDEO_COMPOSE_RESULT_TYPE, {
        schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
        type: VIDEO_COMPOSE_RESULT_TYPE,
        ok: false,
        jobKey,
        error: { code: "INTERNAL", message: error instanceof Error ? error.message : "unexpected error", retryable: true, attempts: 1 },
        completedAt: new Date().toISOString(),
      } satisfies VideoComposeResult);
      channel.ack(message);
    }
  };

  await channel.consume(input.queue, (message) => {
    if (!message) return;
    if (stopping) {
      channel.nack(message, false, true);
      return;
    }
    const running = handle(message).finally(() => inflight.delete(running));
    inflight.add(running);
  });

  return {
    stop() {
      stopping = true;
    },
    async drain() {
      await Promise.allSettled([...inflight]);
    },
  };
}
