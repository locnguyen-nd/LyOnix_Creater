import {
  assertMediaJobQueue,
  MEDIA_FETCH_JOB_TYPE,
  MEDIA_FETCH_RESULT_TYPE,
  MEDIA_JOB_SCHEMA_VERSION,
  MEDIA_SEARCH_JOB_TYPE,
  MEDIA_SEARCH_RESULT_TYPE,
  type MediaFetchResult,
  type MediaJobChannel,
  type MediaJobMessage,
  type MediaSearchResult,
} from "@lyonix/media-jobs";
import type { ConsumerHandle } from "../consumer.js";
import type { SocialFetchProcessor } from "./processor.js";

/**
 * VE2E-144: wires SocialFetchProcessor to `lyonix.media.fetch`: parse -> process -> one result to `replyTo` (same correlationId) ->
 * ack. Poison messages get an INVALID_JOB result and are acked (never requeued forever). The processor never throws for a job
 * failure, so the catch below only covers bugs.
 */
export async function startSocialFetchConsumer(input: {
  channel: MediaJobChannel;
  queue: string;
  prefetch: number;
  processor: SocialFetchProcessor;
  log?: (message: string) => void;
}): Promise<ConsumerHandle> {
  const { channel, processor } = input;
  const log = input.log ?? (() => undefined);
  const inflight = new Set<Promise<void>>();
  let stopping = false;

  await assertMediaJobQueue(channel, input.queue);
  await channel.prefetch(input.prefetch);

  const reply = (message: MediaJobMessage, result: MediaFetchResult | MediaSearchResult) => {
    const { replyTo, correlationId } = message.properties;
    if (!replyTo) return;
    channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(result)), { contentType: "application/json", type: result.type, ...(correlationId ? { correlationId } : {}) });
  };

  const failed = (type: typeof MEDIA_FETCH_RESULT_TYPE | typeof MEDIA_SEARCH_RESULT_TYPE, jobKey: string, code: "INVALID_JOB" | "INTERNAL", text: string) =>
    ({
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type,
      ok: false,
      jobKey,
      error: { code, message: text, retryable: code === "INTERNAL", attempts: 0 },
      completedAt: new Date().toISOString(),
    }) as MediaFetchResult | MediaSearchResult;

  const handle = async (message: MediaJobMessage) => {
    let body: unknown;
    try {
      body = JSON.parse(message.content.toString("utf8"));
    } catch {
      reply(message, failed(MEDIA_FETCH_RESULT_TYPE, message.properties.messageId ?? "invalid", "INVALID_JOB", "message body is not JSON"));
      channel.ack(message);
      return;
    }
    const type = (body as { type?: unknown } | null)?.type;
    const jobKey = typeof (body as { jobKey?: unknown } | null)?.jobKey === "string" ? (body as { jobKey: string }).jobKey : "invalid";
    const resultType = type === MEDIA_SEARCH_JOB_TYPE ? MEDIA_SEARCH_RESULT_TYPE : MEDIA_FETCH_RESULT_TYPE;
    if (type !== MEDIA_FETCH_JOB_TYPE && type !== MEDIA_SEARCH_JOB_TYPE) {
      reply(message, failed(resultType, jobKey, "INVALID_JOB", `unsupported job type on the fetch queue: ${String(type)}`));
      channel.ack(message);
      return;
    }
    try {
      const result = type === MEDIA_FETCH_JOB_TYPE ? await processor.handleFetch(body) : await processor.handleSearch(body);
      log(
        result.ok
          ? result.type === MEDIA_FETCH_RESULT_TYPE
            ? `media.fetch ${result.jobKey} ok ${result.tool.name}@${result.tool.version} bytes=${result.bytes} runs=${result.attempts.map((a) => a.step).join(",")} ${result.elapsedMs}ms`
            : `media.search ${result.jobKey} ok ${result.tool.name}@${result.tool.version} items=${result.items.length} ${result.elapsedMs}ms`
          : `${type} ${result.jobKey} failed ${result.error.code}`,
      );
      reply(message, result);
    } catch (error) {
      reply(message, failed(resultType, jobKey, "INTERNAL", error instanceof Error ? error.message : "unexpected error"));
    }
    channel.ack(message);
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
