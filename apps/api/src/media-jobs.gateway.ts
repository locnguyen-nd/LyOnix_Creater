import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { MediaJobClient, MediaJobClientError, type ClipPrepareJobInput, type ClipPrepareResult } from "@lyonix/media-jobs";

/** Per-clip wait for a media-worker result (env `MEDIA_PREPARE_TIMEOUT_MS`, default 180s). */
export const mediaPrepareTimeoutMs = (): number => {
  const raw = Number(process.env.MEDIA_PREPARE_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 1_000 && raw <= 30 * 60_000 ? raw : 180_000;
};

export interface ClipPreparer {
  prepareClip(job: ClipPrepareJobInput, options?: { timeoutMs?: number }): Promise<ClipPrepareResult>;
}

/**
 * VE2E-37: API-side handle on `apps/media-worker` (the only FFmpeg process). Connects to
 * RabbitMQ lazily on the first clip request, so renders without source ranges never need a
 * broker. Throws `MediaJobClientError` (`MEDIA_WORKER_NOT_CONFIGURED`, `BROKER_UNAVAILABLE`,
 * `RESULT_TIMEOUT`, ...) — callers map it to a render error, never to a full-source fallback.
 */
@Injectable()
export class MediaJobsGateway implements ClipPreparer, OnModuleDestroy {
  private client: Promise<MediaJobClient> | null = null;

  private connect(): Promise<MediaJobClient> {
    if (!this.client) {
      const pending = MediaJobClient.connect({ url: process.env.RABBITMQ_URL, queue: process.env.MEDIA_WORKER_QUEUE });
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

  async onModuleDestroy(): Promise<void> {
    const pending = this.client;
    this.client = null;
    if (pending) await pending.then((client) => client.close()).catch(() => undefined);
  }
}
