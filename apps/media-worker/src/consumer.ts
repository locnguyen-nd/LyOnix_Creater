import {
  assertMediaJobQueue,
  CLIP_PREPARE_JOB_TYPE,
  CLIP_PREPARE_RESULT_TYPE,
  FRAME_EXTRACT_JOB_TYPE,
  FRAME_EXTRACT_RESULT_TYPE,
  MEDIA_JOB_SCHEMA_VERSION,
  REFRAME_ANALYZE_JOB_TYPE,
  REFRAME_ANALYZE_RESULT_TYPE,
  type ClipPrepareResult,
  type FrameExtractResult,
  type MediaJobChannel,
  type MediaJobMessage,
  type ReframeAnalyzeResult,
} from "@lyonix/media-jobs";
import type { ClipPrepareProcessor } from "./clip-prepare.js";
import type { FrameExtractProcessor } from "./frame-extract.js";
import type { ReframeAnalyzeProcessor } from "./reframe-analyze.js";
import { JobLockBusyError } from "./job-errors.js";

export type ConsumerHandle = {
  /** Stop taking new work: later deliveries are nacked+requeued for another worker/restart. */
  stop(): void;
  /** Resolves when every in-flight message has been settled. */
  drain(): Promise<void>;
};

type AnyResult = ClipPrepareResult | FrameExtractResult | ReframeAnalyzeResult;
type ResultType = typeof CLIP_PREPARE_RESULT_TYPE | typeof FRAME_EXTRACT_RESULT_TYPE | typeof REFRAME_ANALYZE_RESULT_TYPE;

/**
 * Wires the media processors to the media queue: parse -> process -> publish result to
 * `replyTo` with the same `correlationId` -> ack. Routes by message `type`: `clip.prepare`
 * (VE2E-36/37) and `frame.extract` (VE2E-30). Poison messages (bad JSON / unknown type /
 * invalid job) get an INVALID_JOB result and are acked, never requeued forever.
 * A job locked by another process is nacked+requeued after `lockRetryDelayMs`.
 */
export async function startClipPrepareConsumer(input: {
  channel: MediaJobChannel;
  queue: string;
  prefetch: number;
  processor: ClipPrepareProcessor;
  /** VE2E-30: when absent, `frame.extract` messages are answered with INVALID_JOB (unsupported). */
  frameProcessor?: FrameExtractProcessor;
  /** VE2E-66: when absent, `reframe.analyze` messages are answered with INVALID_JOB (unsupported). */
  reframeProcessor?: ReframeAnalyzeProcessor;
  lockRetryDelayMs?: number;
  log?: (message: string) => void;
}): Promise<ConsumerHandle> {
  const { channel, processor, frameProcessor, reframeProcessor } = input;
  const log = input.log ?? (() => undefined);
  const lockRetryDelayMs = input.lockRetryDelayMs ?? 2_000;
  const inflight = new Set<Promise<void>>();
  let stopping = false;

  await assertMediaJobQueue(channel, input.queue);
  await channel.prefetch(input.prefetch);

  const reply = (message: MediaJobMessage, result: AnyResult) => {
    const { replyTo, correlationId } = message.properties;
    if (!replyTo) {
      log(`${result.type} ${result.jobKey}: no replyTo; result kept in idempotency store only`);
      return;
    }
    channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(result)), {
      contentType: "application/json",
      type: result.type,
      ...(correlationId ? { correlationId } : {}),
    });
  };

  const invalid = (jobKey: string, message: string, resultType: ResultType = CLIP_PREPARE_RESULT_TYPE): AnyResult => ({
    schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
    type: resultType,
    ok: false,
    jobKey,
    error: { code: "INVALID_JOB", message, retryable: false, attempts: 0 },
    completedAt: new Date().toISOString(),
  } as AnyResult);

  const describe = (result: AnyResult): string => {
    if (!result.ok) return `${result.type.replace(".result", "")} ${result.jobKey} failed ${result.error.code}: ${result.error.message}`;
    if (result.type === CLIP_PREPARE_RESULT_TYPE) {
      return `clip.prepare ${result.jobKey} ok mode=${result.mode} reused=${result.reused} bytes=${result.output.bytes} driftStart=${result.drift.startMs}ms driftDuration=${result.drift.durationMs}ms`;
    }
    if (result.type === REFRAME_ANALYZE_RESULT_TYPE) {
      return `reframe.analyze ${result.jobKey} ok reused=${result.reused} subject=${result.analysis.subjectSource} zoom=${result.cropPlan.zoomPermille} unavoidable=${result.overlayUnavoidable} confidence=${result.confidence.level} totalMs=${result.metrics.totalMs}`;
    }
    return `frame.extract ${result.jobKey} ok reused=${result.reused} frames=${result.frames.length} skipped=${result.skippedFrames}`;
  };

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
    const resultTypeFor = (t: unknown): ResultType => (t === FRAME_EXTRACT_JOB_TYPE ? FRAME_EXTRACT_RESULT_TYPE : t === REFRAME_ANALYZE_JOB_TYPE ? REFRAME_ANALYZE_RESULT_TYPE : CLIP_PREPARE_RESULT_TYPE);
    if (type !== CLIP_PREPARE_JOB_TYPE && !(type === FRAME_EXTRACT_JOB_TYPE && frameProcessor) && !(type === REFRAME_ANALYZE_JOB_TYPE && reframeProcessor)) {
      reply(message, invalid(message.properties.messageId ?? "invalid", `unsupported media job type ${String(type)}`, resultTypeFor(type)));
      channel.ack(message);
      return;
    }
    const resultType = resultTypeFor(type);
    try {
      const result: AnyResult = type === FRAME_EXTRACT_JOB_TYPE ? await frameProcessor!.handle(body) : type === REFRAME_ANALYZE_JOB_TYPE ? await reframeProcessor!.handle(body) : await processor.handle(body);
      log(describe(result));
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
        type: resultType,
        ok: false,
        jobKey,
        error: { code: "INTERNAL", message: error instanceof Error ? error.message : "unknown error", retryable: true, attempts: 0 },
        completedAt: new Date().toISOString(),
      } as AnyResult);
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
