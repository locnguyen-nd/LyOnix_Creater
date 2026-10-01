import { config as loadEnv } from "dotenv";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMediaJobBroker, redactBrokerUrl, type MediaJobBrokerConnection } from "@lyonix/media-jobs";
import { ClipPrepareProcessor, MEDIA_JOBS_DIR } from "./clip-prepare.js";
import { loadMediaWorkerConfig, MediaWorkerConfigError } from "./config.js";
import { startClipPrepareConsumer, type ConsumerHandle } from "./consumer.js";
import { BinaryNotFoundError, readToolVersion, runProcess } from "./process.js";
import { sweepExpiredMediaJobs } from "./ttl-sweep.js";

/**
 * VE2E-36: LyOnix media worker — the only process that runs FFmpeg. Consumes
 * `clip.prepare` jobs from RabbitMQ (`MEDIA_WORKER_QUEUE`) and replies on `replyTo` with
 * the same `correlationId`. Started by `apps/worker/src/run-workers.ts` (pnpm dev/start).
 * Never imported by apps/api's HTTP layer.
 */

loadEnv({ path: resolve(process.cwd(), ".env"), quiet: true });
loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
loadEnv({ path: resolve(process.cwd(), ".env.local"), override: true, quiet: true });

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const log = (message: string) => console.info(`[media-worker] ${message}`);
const fail = (message: string): never => {
  console.error(`[media-worker] ${message}`);
  process.exit(1);
};

/** AggregateError (e.g. ECONNREFUSED on ::1 and 127.0.0.1) has an empty message; surface the code instead. */
const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  const inner = error instanceof AggregateError ? error.errors.map((e: unknown) => (e instanceof Error ? (e as NodeJS.ErrnoException).code ?? e.message : String(e))) : [];
  return [...new Set([error.message, code, ...inner].filter(Boolean))].join(" ") || error.name;
};

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const bootstrap = async () => {
  let cfg;
  try {
    cfg = loadMediaWorkerConfig(process.env, repoRoot);
  } catch (error) {
    return fail(error instanceof MediaWorkerConfigError ? error.message : String(error));
  }
  if (!cfg.rabbitmqUrl) return fail("RABBITMQ_URL is not set; media worker cannot consume jobs (see .env.example)");

  let ffmpegVersion: string;
  try {
    ffmpegVersion = await readToolVersion(runProcess, cfg.ffmpegPath);
    await readToolVersion(runProcess, cfg.ffprobePath);
  } catch (error) {
    const missing = error instanceof BinaryNotFoundError ? error.binary : null;
    return fail(
      missing
        ? `FFmpeg binary "${missing}" not found. Install FFmpeg (ffmpeg + ffprobe) and put it on PATH, or set FFMPEG_PATH / FFPROBE_PATH to the executables.`
        : `FFmpeg check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  log(`using ${ffmpegVersion}; MEDIA_ROOT=${cfg.mediaRoot}; copy tolerance ${cfg.copyToleranceMs}ms; timeout ${cfg.jobTimeoutMs}ms x ${cfg.maxAttempts} attempts`);

  await mkdir(join(cfg.mediaRoot, MEDIA_JOBS_DIR), { recursive: true });
  const sweep = async () => {
    try {
      const { removed } = await sweepExpiredMediaJobs(cfg.mediaRoot);
      if (removed > 0) log(`TTL sweep removed ${removed} expired clip job(s)`);
    } catch (error) {
      console.warn("[media-worker] TTL sweep failed", error instanceof Error ? error.message : error);
    }
  };
  await sweep();
  const sweepTimer = setInterval(() => void sweep(), cfg.sweepIntervalMs);
  sweepTimer.unref();

  const processor = new ClipPrepareProcessor({ config: cfg, runner: runProcess, ffmpegVersion, log });

  let stopping = false;
  let connection: MediaJobBrokerConnection | null = null;
  let consumer: ConsumerHandle | null = null;
  let wake: (() => void) | null = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    consumer?.stop();
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const brokerLabel = redactBrokerUrl(cfg.rabbitmqUrl);
  let backoffMs = 1_000;
  while (!stopping) {
    try {
      connection = await connectMediaJobBroker(cfg.rabbitmqUrl);
    } catch (error) {
      console.warn(`[media-worker] RabbitMQ unavailable at ${brokerLabel} (${describeError(error)}); retrying in ${backoffMs / 1000}s`);
      await Promise.race([sleep(backoffMs), new Promise<void>((r) => { wake = r; })]);
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }
    backoffMs = 1_000;
    const closed = new Promise<void>((resolveClosed) => {
      connection!.onClose((error) => {
        if (!stopping) console.warn(`[media-worker] RabbitMQ connection lost${error ? `: ${error.message}` : ""}; reconnecting`);
        resolveClosed();
      });
    });
    consumer = await startClipPrepareConsumer({ channel: connection.channel, queue: cfg.queue, prefetch: cfg.prefetch, processor, log });
    log(`ready on queue ${cfg.queue} (${brokerLabel}); prefetch=${cfg.prefetch} ffmpegThreads=${cfg.ffmpegThreads}; FFmpeg runs here only`);
    await Promise.race([closed, new Promise<void>((r) => { wake = r; })]);
    if (stopping) {
      await consumer.drain();
      await connection.close();
    }
    consumer = null;
  }
  clearInterval(sweepTimer);
  log("stopped");
};

void bootstrap();
