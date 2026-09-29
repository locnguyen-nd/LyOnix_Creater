import { randomUUID } from "node:crypto";
import {
  buildClipPrepareJob,
  CLIP_PREPARE_JOB_TYPE,
  DEFAULT_MEDIA_WORKER_QUEUE,
  MediaJobClientError,
  parseClipPrepareResult,
  validateClipPrepareJob,
  type ClipPrepareJob,
  type ClipPrepareJobInput,
  type ClipPrepareResult,
} from "./contract.js";
import { assertMediaJobQueue, connectMediaJobBroker, type MediaJobBrokerConnection, type MediaJobChannel, type MediaJobMessage } from "./transport.js";

/** Worker defaults: 120s per attempt x 2 attempts; client waits a bit longer than that. */
export const DEFAULT_MEDIA_JOB_RESULT_TIMEOUT_MS = 300_000;

export type PrepareClipOptions = {
  /** How long to wait for the worker's result before rejecting with RESULT_TIMEOUT. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

type Pending = {
  jobKey: string;
  resolve: (result: ClipPrepareResult) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
};

/**
 * Enqueue + await-result client for `apps/media-worker` (RPC over RabbitMQ with a
 * private, auto-deleted reply queue). Long-lived: create once per process and reuse.
 *
 * Resolves with the worker's `ClipPrepareResult` (which may be `ok: false` with an
 * error code); rejects with `MediaJobClientError` only for transport-level problems
 * (not configured, broker down, timeout, malformed result). Because jobs are
 * idempotent by `jobKey`, a caller that timed out can simply call `prepareClip` again
 * with the same job — the worker returns the stored result without re-running FFmpeg.
 */
export class MediaJobClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  private constructor(
    private readonly channel: MediaJobChannel,
    private readonly queue: string,
    private readonly replyQueue: string,
    private readonly defaultTimeoutMs: number,
    private readonly connection: MediaJobBrokerConnection | null,
  ) {}

  /** Connects to RabbitMQ. Fails fast with MEDIA_WORKER_NOT_CONFIGURED when no URL is configured. */
  static async connect(options: { url: string | undefined; queue?: string | undefined; defaultTimeoutMs?: number | undefined }): Promise<MediaJobClient> {
    const url = options.url?.trim();
    if (!url) throw new MediaJobClientError("MEDIA_WORKER_NOT_CONFIGURED", "RABBITMQ_URL is not configured; media-worker jobs cannot be enqueued");
    let connection: MediaJobBrokerConnection;
    try {
      connection = await connectMediaJobBroker(url);
    } catch (error) {
      throw new MediaJobClientError("BROKER_UNAVAILABLE", `Cannot connect to RabbitMQ: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return MediaJobClient.create({ channel: connection.channel, queue: options.queue, defaultTimeoutMs: options.defaultTimeoutMs, connection });
  }

  /** Builds a client over an existing channel (used by `connect` and by tests with an in-memory channel). */
  static async create(options: {
    channel: MediaJobChannel;
    queue?: string | undefined;
    defaultTimeoutMs?: number | undefined;
    connection?: MediaJobBrokerConnection | null;
  }): Promise<MediaJobClient> {
    const queue = options.queue?.trim() || DEFAULT_MEDIA_WORKER_QUEUE;
    await assertMediaJobQueue(options.channel, queue);
    const reply = await options.channel.assertQueue("", { exclusive: true, autoDelete: true, durable: false });
    const client = new MediaJobClient(options.channel, queue, reply.queue, options.defaultTimeoutMs ?? DEFAULT_MEDIA_JOB_RESULT_TIMEOUT_MS, options.connection ?? null);
    await options.channel.consume(reply.queue, (message) => client.onReply(message), { noAck: true });
    const onClose = (error?: Error) =>
      client.failAll(new MediaJobClientError("BROKER_UNAVAILABLE", `RabbitMQ connection closed${error ? `: ${error.message}` : ""}`));
    if (options.connection) options.connection.onClose(onClose);
    else options.channel.on("close", () => onClose());
    return client;
  }

  /** Number of jobs currently awaiting a result (diagnostics/tests). */
  get inFlight(): number {
    return this.pending.size;
  }

  prepareClip(job: ClipPrepareJob | ClipPrepareJobInput, options: PrepareClipOptions = {}): Promise<ClipPrepareResult> {
    if (this.closed) return Promise.reject(new MediaJobClientError("BROKER_UNAVAILABLE", "MediaJobClient is closed"));
    const candidate = "schemaVersion" in job ? job : buildClipPrepareJob(job);
    const validation = validateClipPrepareJob(candidate);
    if (!validation.ok) return Promise.reject(new MediaJobClientError("INVALID_JOB", validation.errors.join("; ")));
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const correlationId = randomUUID();
    return new Promise<ClipPrepareResult>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error("aborted"));
        return;
      }
      const onAbort = () => {
        const entry = this.pending.get(correlationId);
        if (!entry) return;
        entry.cleanup();
        reject(options.signal?.reason ?? new Error("aborted"));
      };
      const timer = setTimeout(() => {
        const entry = this.pending.get(correlationId);
        if (!entry) return;
        entry.cleanup();
        reject(new MediaJobClientError("RESULT_TIMEOUT", `No clip.prepare result for jobKey ${validation.value.jobKey} within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(correlationId);
      };
      this.pending.set(correlationId, { jobKey: validation.value.jobKey, resolve, reject, timer, cleanup });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.channel.sendToQueue(this.queue, Buffer.from(JSON.stringify(validation.value)), {
          persistent: true,
          contentType: "application/json",
          type: CLIP_PREPARE_JOB_TYPE,
          messageId: validation.value.jobKey,
          correlationId,
          replyTo: this.replyQueue,
          // Nobody awaits the result after the timeout; let RabbitMQ drop it if still unconsumed.
          expiration: String(timeoutMs),
        });
      } catch (error) {
        cleanup();
        reject(new MediaJobClientError("BROKER_UNAVAILABLE", `Failed to publish clip.prepare: ${error instanceof Error ? error.message : "unknown error"}`));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.failAll(new MediaJobClientError("BROKER_UNAVAILABLE", "MediaJobClient closed"));
    this.closed = true;
    if (this.connection) await this.connection.close();
  }

  private onReply(message: MediaJobMessage | null): void {
    if (!message) return;
    const correlationId = message.properties.correlationId;
    if (!correlationId) return;
    const entry = this.pending.get(correlationId);
    if (!entry) return; // late reply after timeout/abort — ignored; the worker's stored result is reusable by jobKey
    entry.cleanup();
    let parsed: ClipPrepareResult | null = null;
    try {
      parsed = parseClipPrepareResult(JSON.parse(message.content.toString("utf8")));
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.jobKey !== entry.jobKey) {
      entry.reject(new MediaJobClientError("INVALID_RESULT", `Malformed clip.prepare result for jobKey ${entry.jobKey}`));
      return;
    }
    entry.resolve(parsed);
  }

  private failAll(error: MediaJobClientError): void {
    for (const entry of [...this.pending.values()]) {
      entry.cleanup();
      entry.reject(error);
    }
  }
}
