import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { isMediaQueueSplitEnabled, MediaJobClient, MediaJobClientError, type ComposeVideoOptions, type VideoComposeJobInput, type VideoComposeResult, type ClipPrepareJobInput, type ClipPrepareResult, type FrameExtractJobInput, type FrameExtractResult, type ReframeAnalyzeJobInput, type ReframeAnalyzeResult, type MediaFetchJobInput, type MediaFetchResult, type MediaSearchJobInput, type MediaSearchResult } from "@lyonix/media-jobs";

/** Per-clip wait for a media-worker result (env `MEDIA_PREPARE_TIMEOUT_MS`, default 180s). */
export const mediaPrepareTimeoutMs = (): number => {
  const raw = Number(process.env.MEDIA_PREPARE_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 1_000 && raw <= 30 * 60_000 ? raw : 180_000;
};

export interface ClipPreparer {
  prepareClip(job: ClipPrepareJobInput, options?: { timeoutMs?: number }): Promise<ClipPrepareResult>;
}

/** VE2E-30: frame sampling for vision moderation (same worker/queue as clip.prepare). */
export interface FrameExtractor {
  extractFrames(job: FrameExtractJobInput, options?: { timeoutMs?: number }): Promise<FrameExtractResult>;
}

/** VE2E-67: subject/overlay analysis (crop plan) from the media worker's local detectors. */
export interface ReframeAnalyzer {
  analyzeReframe(job: ReframeAnalyzeJobInput, options?: { timeoutMs?: number }): Promise<ReframeAnalyzeResult>;
}

/** VE2E-144: yt-dlp / gallery-dl downloads and searches on the worker's fetch queue (`lyonix.media.fetch`). */
export interface SocialFetcher {
  fetchMedia(job: MediaFetchJobInput): Promise<MediaFetchResult>;
  searchMedia(job: MediaSearchJobInput): Promise<MediaSearchResult>;
}

/**
 * VE2E-110: the internal render engine (`video.compose` on `lyonix.render`). `renderQueueStatus` reports whether any render worker is attached
 * (`consumers: 0` = the engine is not running) and the backlog, which the Render Router uses for `local_unhealthy` / overflow.
 */
export interface VideoComposer {
  composeVideo(job: VideoComposeJobInput, options?: ComposeVideoOptions): Promise<VideoComposeResult>;
  renderQueueStatus(): Promise<{ consumers: number; queued: number } | null>;
}

/**
 * VE2E-37: API-side handle on `apps/media-worker` (the only FFmpeg process). Connects to
 * RabbitMQ lazily on the first clip request, so renders without source ranges never need a
 * broker. Throws `MediaJobClientError` (`MEDIA_WORKER_NOT_CONFIGURED`, `BROKER_UNAVAILABLE`,
 * `RESULT_TIMEOUT`, ...) — callers map it to a render error, never to a full-source fallback.
 */
@Injectable()
export class MediaJobsGateway implements ClipPreparer, FrameExtractor, ReframeAnalyzer, VideoComposer, SocialFetcher, OnModuleDestroy {
  private client: Promise<MediaJobClient> | null = null;

  private connect(): Promise<MediaJobClient> {
    if (!this.client) {
      const pending = MediaJobClient.connect({ url: process.env.RABBITMQ_URL, queue: process.env.MEDIA_WORKER_QUEUE, renderQueue: process.env.MEDIA_WORKER_RENDER_QUEUE, splitQueues: isMediaQueueSplitEnabled(process.env.MEDIA_QUEUE_SPLIT), frameQueue: process.env.MEDIA_WORKER_QUEUE_FRAME, reframeQueue: process.env.MEDIA_WORKER_QUEUE_REFRAME, fetchQueue: process.env.MEDIA_WORKER_QUEUE_FETCH });
      this.client = pending;
      pending.catch(() => {
        if (this.client === pending) this.client = null; // next call retries the connection
      });
    }
    return this.client;
  }

  async prepareClip(job: ClipPrepareJobInput, options: { timeoutMs?: number } = {}): Promise<ClipPrepareResult> {
    const client = await this.connect();
    try {
      return await client.prepareClip(job, { timeoutMs: options.timeoutMs ?? mediaPrepareTimeoutMs() });
    } catch (error) {
      if (error instanceof MediaJobClientError && error.code === "BROKER_UNAVAILABLE") {
        this.client = null; // connection dropped: reconnect on the next call
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async extractFrames(job: FrameExtractJobInput, options: { timeoutMs?: number } = {}): Promise<FrameExtractResult> {
    const client = await this.connect();
    try {
      return await client.extractFrames(job, { timeoutMs: options.timeoutMs ?? mediaPrepareTimeoutMs() });
    } catch (error) {
      if (error instanceof MediaJobClientError && error.code === "BROKER_UNAVAILABLE") {
        this.client = null;
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async analyzeReframe(job: ReframeAnalyzeJobInput, options: { timeoutMs?: number } = {}): Promise<ReframeAnalyzeResult> {
    const client = await this.connect();
    try {
      return await client.analyzeReframe(job, { timeoutMs: options.timeoutMs ?? mediaPrepareTimeoutMs() });
    } catch (error) {
      if (error instanceof MediaJobClientError && error.code === "BROKER_UNAVAILABLE") {
        this.client = null;
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async fetchMedia(job: MediaFetchJobInput): Promise<MediaFetchResult> {
    return this.withReconnect((client) => client.fetchMedia(job));
  }

  async searchMedia(job: MediaSearchJobInput): Promise<MediaSearchResult> {
    return this.withReconnect((client) => client.searchMedia(job));
  }

  private async withReconnect<T>(call: (client: MediaJobClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await call(client);
    } catch (error) {
      if (error instanceof MediaJobClientError && error.code === "BROKER_UNAVAILABLE") {
        this.client = null;
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  /** Never throws for a missing/unreachable broker: the router treats `null` as "engine unavailable". */
  async renderQueueStatus(): Promise<{ consumers: number; queued: number } | null> {
    try {
      return await (await this.connect()).renderQueueStatus();
    } catch {
      return null;
    }
  }

  async composeVideo(job: VideoComposeJobInput, options: ComposeVideoOptions = {}): Promise<VideoComposeResult> {
    const client = await this.connect();
    try {
      return await client.composeVideo(job, options);
    } catch (error) {
      if (error instanceof MediaJobClientError && error.code === "BROKER_UNAVAILABLE") {
        this.client = null;
        await client.close().catch(() => undefined);
      }
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    const pending = this.client;
    this.client = null;
    if (pending) await pending.then((client) => client.close()).catch(() => undefined);
  }
}
