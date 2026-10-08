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
import {
  buildVideoComposeJob,
  DEFAULT_RENDER_QUEUE,
  parseVideoComposeProgress,
  parseVideoComposeResult,
  validateVideoComposeJob,
  VIDEO_COMPOSE_JOB_TYPE,
  VIDEO_COMPOSE_PROGRESS_TYPE,
  type VideoComposeJob,
  type VideoComposeJobInput,
  type VideoComposeProgress,
  type VideoComposeResult,
} from "./compose-contract.js";
import {
  buildFrameExtractJob,
  FRAME_EXTRACT_JOB_TYPE,
  parseFrameExtractResult,
  validateFrameExtractJob,
  type FrameExtractJob,
  type FrameExtractJobInput,
  type FrameExtractResult,
} from "./frame-contract.js";
import {
  buildReframeAnalyzeJob,
  parseReframeAnalyzeResult,
  REFRAME_ANALYZE_JOB_TYPE,
  validateReframeAnalyzeJob,
  type ReframeAnalyzeJob,
  type ReframeAnalyzeJobInput,
  type ReframeAnalyzeResult,
} from "./reframe-contract.js";
import { resolveProducerQueues, splitMediaJobQueueNames } from "./queues.js";
import { assertMediaJobQueue, connectMediaJobBroker, type MediaJobBrokerConnection, type MediaJobChannel, type MediaJobMessage } from "./transport.js";

/** Worker defaults: 120s per attempt x 2 attempts; client waits a bit longer than that. */
export const DEFAULT_MEDIA_JOB_RESULT_TIMEOUT_MS = 300_000;
/** VE2E-104: a render is long; the client only gives up after this long WITHOUT a progress message (each progress restarts the wait). */
export const DEFAULT_COMPOSE_IDLE_TIMEOUT_MS = 10 * 60_000;

export type PrepareClipOptions = {
  /** How long to wait for the worker's result before rejecting with RESULT_TIMEOUT. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ComposeVideoOptions = PrepareClipOptions & {
  /** Called for every `video.compose.progress` message of this job (never for other jobs). */
  onProgress?: (progress: VideoComposeProgress) => void;
};

type Pending = {
  jobKey: string;
  jobType: string;
  parse: (input: unknown) => { jobKey: string } | null;
  resolve: (result: never) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  /** VE2E-104: progress callback + idle-timer restart (only for job types that stream progress). */
  onProgress?: (body: unknown) => boolean;
};

/**
 * Enqueue + await-result client for `apps/media-worker` (RPC over RabbitMQ with a
 * private, auto-deleted reply queue). Long-lived: create once per process and reuse.
 *
 * Resolves with the worker's result (which may be `ok: false` with an error code); rejects
 * with `MediaJobClientError` only for transport-level problems (not configured, broker
 * down, timeout, malformed result). Because jobs are idempotent by `jobKey`, a caller that
 * timed out can simply call again with the same job — the worker returns the stored result
 * without re-running FFmpeg. Job types: `clip.prepare` (VE2E-36/37) and `frame.extract` (VE2E-30).
 */
export class MediaJobClient {
  private readonly pending = new Map<string, Pending>();
  private renderQueueReady: Promise<unknown> | null = null;
  private readonly splitQueueReady = new Map<string, Promise<unknown>>();
  private closed = false;

  private constructor(
    private readonly channel: MediaJobChannel,
    private readonly queue: string,
    private readonly renderQueue: string,
    private readonly replyQueue: string,
    private readonly defaultTimeoutMs: number,
    private readonly connection: MediaJobBrokerConnection | null,
    /** VE2E-134: where frame.extract / reframe.analyze go (the legacy `queue` unless the split is enabled). */
    private readonly routes: { frameExtract: string; reframeAnalyze: string } = { frameExtract: queue, reframeAnalyze: queue },
  ) {}

  /** Connects to RabbitMQ. Fails fast with MEDIA_WORKER_NOT_CONFIGURED when no URL is configured. */
  static async connect(options: { url: string | undefined; queue?: string | undefined; renderQueue?: string | undefined; defaultTimeoutMs?: number | undefined; splitQueues?: boolean | undefined; frameQueue?: string | undefined; reframeQueue?: string | undefined }): Promise<MediaJobClient> {
    const url = options.url?.trim();
    if (!url) throw new MediaJobClientError("MEDIA_WORKER_NOT_CONFIGURED", "RABBITMQ_URL is not configured; media-worker jobs cannot be enqueued");
    let connection: MediaJobBrokerConnection;
    try {
      connection = await connectMediaJobBroker(url);
    } catch (error) {
      throw new MediaJobClientError("BROKER_UNAVAILABLE", `Cannot connect to RabbitMQ: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return MediaJobClient.create({ channel: connection.channel, queue: options.queue, renderQueue: options.renderQueue, defaultTimeoutMs: options.defaultTimeoutMs, connection, splitQueues: options.splitQueues, frameQueue: options.frameQueue, reframeQueue: options.reframeQueue });
  }

  /** Builds a client over an existing channel (used by `connect` and by tests with an in-memory channel). */
  static async create(options: {
    channel: MediaJobChannel;
    queue?: string | undefined;
    /** VE2E-104: queue for `video.compose` (default `lyonix.render`); declared lazily on the first compose so deployments without the render worker are unaffected. */
    renderQueue?: string | undefined;
    defaultTimeoutMs?: number | undefined;
    connection?: MediaJobBrokerConnection | null;
    /** VE2E-134: route frame.extract / reframe.analyze to their own queues (`<queue>.frame` / `<queue>.reframe`); default off = legacy single queue. */
    splitQueues?: boolean | undefined;
    frameQueue?: string | undefined;
    reframeQueue?: string | undefined;
  }): Promise<MediaJobClient> {
    const queue = options.queue?.trim() || DEFAULT_MEDIA_WORKER_QUEUE;
    const renderQueue = options.renderQueue?.trim() || DEFAULT_RENDER_QUEUE;
    await assertMediaJobQueue(options.channel, queue);
    const reply = await options.channel.assertQueue("", { exclusive: true, autoDelete: true, durable: false });
    const names = splitMediaJobQueueNames({ MEDIA_WORKER_QUEUE: queue, MEDIA_WORKER_QUEUE_FRAME: options.frameQueue, MEDIA_WORKER_QUEUE_REFRAME: options.reframeQueue, MEDIA_WORKER_RENDER_QUEUE: renderQueue });
    const routed = resolveProducerQueues(names, options.splitQueues === true);
    const client = new MediaJobClient(options.channel, queue, renderQueue, reply.queue, options.defaultTimeoutMs ?? DEFAULT_MEDIA_JOB_RESULT_TIMEOUT_MS, options.connection ?? null, { frameExtract: routed.frame_extract, reframeAnalyze: routed.reframe_analyze });
    await options.channel.consume(reply.queue, (message) => client.onReply(message), { noAck: true });
    const onClose = (error?: Error) =>
      client.failAll(new MediaJobClientError("BROKER_UNAVAILABLE", `RabbitMQ connection closed${error ? `: ${error.message}` : ""}`));
    if (options.connection) options.connection.onClose(onClose);
    else options.channel.on("close", () => onClose());
    return client;
  }

  /**
   * VE2E-110: state of the render queue as the Render Router sees it: `consumers` = render workers attached (0 => the internal engine is not
   * running), `queued` = renders waiting for one. `null` when the channel cannot inspect queues. Declares the queue first (idempotent) so
   * inspecting a never-used queue does not close the channel.
   */
  async renderQueueStatus(): Promise<{ consumers: number; queued: number } | null> {
    if (!this.channel.checkQueue) return null;
    try {
      this.renderQueueReady ??= assertMediaJobQueue(this.channel, this.renderQueue);
      await this.renderQueueReady;
      const state = await this.channel.checkQueue(this.renderQueue);
      return { consumers: state.consumerCount, queued: state.messageCount };
    } catch {
      this.renderQueueReady = null;
      return null;
    }
  }

  /** Number of jobs currently awaiting a result (diagnostics/tests). */
  get inFlight(): number {
    return this.pending.size;
  }

  prepareClip(job: ClipPrepareJob | ClipPrepareJobInput, options: PrepareClipOptions = {}): Promise<ClipPrepareResult> {
    const candidate = "schemaVersion" in job ? job : buildClipPrepareJob(job);
    const validation = validateClipPrepareJob(candidate);
    if (!validation.ok) return Promise.reject(new MediaJobClientError("INVALID_JOB", validation.errors.join("; ")));
    return this.request<ClipPrepareResult>(CLIP_PREPARE_JOB_TYPE, validation.value, parseClipPrepareResult, options);
  }

  /** VE2E-30: samples a few JPEG frames from a stored video (for vision moderation). Same retry/idempotency rules as `prepareClip`. */
  async extractFrames(job: FrameExtractJob | FrameExtractJobInput, options: PrepareClipOptions = {}): Promise<FrameExtractResult> {
    const candidate = "schemaVersion" in job ? job : buildFrameExtractJob(job);
    const validation = validateFrameExtractJob(candidate);
    if (!validation.ok) throw new MediaJobClientError("INVALID_JOB", validation.errors.join("; "));
    await this.ensureRoutedQueue(this.routes.frameExtract);
    return this.request<FrameExtractResult>(FRAME_EXTRACT_JOB_TYPE, validation.value, parseFrameExtractResult, options, undefined, this.routes.frameExtract);
  }

  /** VE2E-134: a non-legacy queue is declared lazily on first use (idempotent); the legacy queue was declared in `create`. */
  private async ensureRoutedQueue(name: string): Promise<void> {
    if (name === this.queue) return;
    let ready = this.splitQueueReady.get(name);
    if (!ready) {
      ready = assertMediaJobQueue(this.channel, name);
      this.splitQueueReady.set(name, ready);
    }
    try {
      await ready;
    } catch (error) {
      this.splitQueueReady.delete(name);
      throw new MediaJobClientError("BROKER_UNAVAILABLE", `Cannot declare queue ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /**
   * VE2E-66: analyses subject + overlay of a stored video/image and returns a `CropPlan` (no cutting). Local detectors run in the
   * worker, so a first analysis can take several seconds: pass a larger `timeoutMs` for long clips. Idempotent by `jobKey`.
   */
  async analyzeReframe(job: ReframeAnalyzeJob | ReframeAnalyzeJobInput, options: PrepareClipOptions = {}): Promise<ReframeAnalyzeResult> {
    const candidate = "schemaVersion" in job ? job : buildReframeAnalyzeJob(job);
    const validation = validateReframeAnalyzeJob(candidate);
    if (!validation.ok) throw new MediaJobClientError("INVALID_JOB", validation.errors.join("; "));
    await this.ensureRoutedQueue(this.routes.reframeAnalyze);
    return this.request<ReframeAnalyzeResult>(REFRAME_ANALYZE_JOB_TYPE, validation.value, parseReframeAnalyzeResult, options, undefined, this.routes.reframeAnalyze);
  }

  /**
   * VE2E-104: composes the final 1080x1920 60 fps video in the render worker (`video.compose`, queue `lyonix.render`) and resolves with its
   * result (output + thumbnail + QC report, or `ok: false` with a code). Idempotent by `jobKey`. The wait is an idle timeout: each progress
   * message restarts it, so a long render never times out while it is making progress.
   */
  async composeVideo(job: VideoComposeJob | VideoComposeJobInput, options: ComposeVideoOptions = {}): Promise<VideoComposeResult> {
    const candidate = "schemaVersion" in job ? job : buildVideoComposeJob(job);
    const validation = validateVideoComposeJob(candidate);
    if (!validation.ok) throw new MediaJobClientError("INVALID_JOB", validation.errors.join("; "));
    const { onProgress, ...rest } = options;
    try {
      this.renderQueueReady ??= assertMediaJobQueue(this.channel, this.renderQueue);
      await this.renderQueueReady;
    } catch (error) {
      this.renderQueueReady = null;
      throw new MediaJobClientError("BROKER_UNAVAILABLE", `Cannot declare render queue ${this.renderQueue}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return this.request<VideoComposeResult>(VIDEO_COMPOSE_JOB_TYPE, validation.value, parseVideoComposeResult, { timeoutMs: DEFAULT_COMPOSE_IDLE_TIMEOUT_MS, ...rest }, (body, jobKey) => {
      const progress = parseVideoComposeProgress(body);
      if (!progress || progress.jobKey !== jobKey) return false;
      onProgress?.(progress);
      return true;
    }, this.renderQueue);
  }

  private request<TResult extends { jobKey: string }>(
    jobType: string,
    job: { jobKey: string },
    parse: (input: unknown) => TResult | null,
    options: PrepareClipOptions,
    progress?: (body: unknown, jobKey: string) => boolean,
    queue: string = this.queue,
  ): Promise<TResult> {
    if (this.closed) return Promise.reject(new MediaJobClientError("BROKER_UNAVAILABLE", "MediaJobClient is closed"));
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const correlationId = randomUUID();
    return new Promise<TResult>((resolve, reject) => {
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
        reject(new MediaJobClientError("RESULT_TIMEOUT", `No ${jobType} result for jobKey ${job.jobKey} within ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(this.pending.get(correlationId)?.timer ?? timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(correlationId);
      };
      const entry: Pending = { jobKey: job.jobKey, jobType, parse, resolve: resolve as (result: never) => void, reject, timer, cleanup };
      if (progress) {
        entry.onProgress = (body) => {
          if (!progress(body, job.jobKey)) return false;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            const current = this.pending.get(correlationId);
            if (!current) return;
            current.cleanup();
            reject(new MediaJobClientError("RESULT_TIMEOUT", `No ${jobType} progress/result for jobKey ${job.jobKey} within ${timeoutMs}ms`));
          }, timeoutMs);
          return true;
        };
      }
      this.pending.set(correlationId, entry);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(job)), {
          persistent: true,
          contentType: "application/json",
          type: jobType,
          messageId: job.jobKey,
          correlationId,
          replyTo: this.replyQueue,
          // Nobody awaits the result after the timeout; let RabbitMQ drop it if still unconsumed.
          expiration: String(timeoutMs),
        });
      } catch (error) {
        cleanup();
        reject(new MediaJobClientError("BROKER_UNAVAILABLE", `Failed to publish ${jobType}: ${error instanceof Error ? error.message : "unknown error"}`));
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
    if (entry.onProgress && message.properties.type === VIDEO_COMPOSE_PROGRESS_TYPE) {
      try {
        entry.onProgress(JSON.parse(message.content.toString("utf8")));
      } catch {
        // a malformed progress message never fails the job; the result is what matters
      }
      return;
    }
    entry.cleanup();
    let parsed: { jobKey: string } | null = null;
    try {
      parsed = entry.parse(JSON.parse(message.content.toString("utf8")));
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.jobKey !== entry.jobKey) {
      entry.reject(new MediaJobClientError("INVALID_RESULT", `Malformed ${entry.jobType} result for jobKey ${entry.jobKey}`));
      return;
    }
    entry.resolve(parsed as never);
  }

  private failAll(error: MediaJobClientError): void {
    for (const entry of [...this.pending.values()]) {
      entry.cleanup();
      entry.reject(error);
    }
  }
}
