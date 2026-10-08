import { config as loadEnv } from "dotenv";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMediaJobBroker, redactBrokerUrl, type MediaJobBrokerConnection } from "@lyonix/media-jobs";
import { ClipPrepareProcessor, MEDIA_JOBS_DIR } from "./clip-prepare.js";
import { FrameExtractProcessor } from "./frame-extract.js";
import { ReframeAnalyzeProcessor } from "./reframe-analyze.js";
import { loadReframeConfig } from "./reframe/config.js";
import { OnnxFrameDetector } from "./reframe/onnx-detector.js";
import { loadMediaWorkerConfig, MediaWorkerConfigError } from "./config.js";
import { startClipPrepareConsumer, type ConsumerHandle } from "./consumer.js";
import { BinaryNotFoundError, readToolVersion, runProcess } from "./process.js";
import { ComposeProcessor, RENDERS_DIR } from "./compose/compose-processor.js";
import { ComposeConfigError, loadComposeConfig } from "./compose/config.js";
import { startComposeConsumer } from "./compose/consumer.js";
import { sweepExpiredMediaJobs } from "./ttl-sweep.js";
import { loadSocialFetchConfig } from "./social-fetch/config.js";
import { startSocialFetchConsumer } from "./social-fetch/consumer.js";
import { SocialFetchProcessor, sweepStaleFetchDirs } from "./social-fetch/processor.js";

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

  let composeCfg;
  try {
    composeCfg = loadComposeConfig(process.env, repoRoot);
  } catch (error) {
    return fail(error instanceof ComposeConfigError ? error.message : String(error));
  }
  let fetchCfg;
  try {
    fetchCfg = loadSocialFetchConfig(process.env);
  } catch (error) {
    return fail(error instanceof MediaWorkerConfigError ? error.message : String(error));
  }

  await mkdir(join(cfg.mediaRoot, MEDIA_JOBS_DIR), { recursive: true });
  await mkdir(join(cfg.mediaRoot, RENDERS_DIR), { recursive: true });
  const sweep = async () => {
    try {
      const { removed } = await sweepExpiredMediaJobs(cfg.mediaRoot);
      if (removed > 0) log(`TTL sweep removed ${removed} expired clip job(s)`);
      const fetchDirs = await sweepStaleFetchDirs(cfg.mediaRoot, 60 * 60_000);
      if (fetchDirs > 0) log(`TTL sweep removed ${fetchDirs} abandoned media.fetch download dir(s)`);
    } catch (error) {
      console.warn("[media-worker] TTL sweep failed", error instanceof Error ? error.message : error);
    }
  };
  await sweep();
  const sweepTimer = setInterval(() => void sweep(), cfg.sweepIntervalMs);
  sweepTimer.unref();

  const processor = new ClipPrepareProcessor({ config: cfg, runner: runProcess, ffmpegVersion, log });
  const frameProcessor = new FrameExtractProcessor({ config: cfg, runner: runProcess, ffmpegVersion, log });
  // VE2E-66: local detectors (onnxruntime-node). Models are loaded lazily on the first reframe.analyze job; a missing model fails that
  // job with MODEL_NOT_AVAILABLE (never a silent fallback), it does not stop clip.prepare/frame.extract.
  const reframeCfg = loadReframeConfig(process.env, repoRoot);
  const detector = new OnnxFrameDetector({ modelsDir: reframeCfg.modelsDir, threads: reframeCfg.ortThreads });
  const reframeProcessor = new ReframeAnalyzeProcessor({ config: cfg, reframe: reframeCfg, runner: runProcess, ffmpegVersion, detector, log });
  log(`reframe.analyze: models=${reframeCfg.modelsDir} concurrency=${reframeCfg.concurrency} ortThreads=${reframeCfg.ortThreads} analysisLongSide=${reframeCfg.analysisLongSide}px maxZoom=${reframeCfg.plan.maxZoomPermille / 1000}`);

  // VE2E-105: the internal render engine. Its own queue + connection so a long render never delays clip.prepare/frame.extract.
  const composeProcessor = new ComposeProcessor({ config: cfg, compose: composeCfg, runner: runProcess, ffmpegVersion, log });
  log(`video.compose: queue=${composeCfg.queue} prefetch=${composeCfg.prefetch} preset=${composeCfg.x264Preset} x264Threads=${composeCfg.x264Threads || "auto"} fontsDir=${composeCfg.fontsDir ?? "system fonts"} timeout=${composeCfg.timeoutMs}ms`);

  // VE2E-144: yt-dlp / gallery-dl downloads + searches on their own queue (network-bound, never blocks FFmpeg cuts).
  const fetchProcessor = new SocialFetchProcessor({ config: cfg, fetch: fetchCfg, runner: runProcess, log });
  log(`media.fetch: ${fetchCfg.enabled ? `queue=${fetchCfg.queue} prefetch=${fetchCfg.prefetch}` : "disabled (MEDIA_WORKER_FETCH=0)"} yt-dlp=${fetchCfg.ytDlpPath} gallery-dl=${fetchCfg.galleryDlPath} proxy=${fetchCfg.proxyUrl ? "configured" : "none"}`);

  let stopping = false;
  let connection: MediaJobBrokerConnection | null = null;
  let renderConnection: MediaJobBrokerConnection | null = null;
  let consumers: ConsumerHandle[] = [];
  let renderConsumer: ConsumerHandle | null = null;
  let wake: (() => void) | null = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const c of consumers) c.stop();
    renderConsumer?.stop();
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
    try {
      renderConnection = await connectMediaJobBroker(cfg.rabbitmqUrl);
    } catch (error) {
      await connection.close().catch(() => undefined);
      console.warn(`[media-worker] RabbitMQ unavailable at ${brokerLabel} (${describeError(error)}); retrying in ${backoffMs / 1000}s`);
      await Promise.race([sleep(backoffMs), new Promise<void>((r) => { wake = r; })]);
      backoffMs = Math.min(backoffMs * 2, 30_000);
      continue;
    }
    backoffMs = 1_000;
    const closed = new Promise<void>((resolveClosed) => {
      const onClose = (error?: Error) => {
        if (!stopping) console.warn(`[media-worker] RabbitMQ connection lost${error ? `: ${error.message}` : ""}; reconnecting`);
        resolveClosed();
      };
      connection!.onClose(onClose);
      renderConnection!.onClose(onClose);
    });
    // VE2E-134: one consumer (own prefetch) per queue on the shared channel (RabbitMQ prefetch is per consumer). The legacy queue also
    // serves every job type, so messages from an old API / before MEDIA_QUEUE_SPLIT are still processed; the split queues isolate frame/reframe.
    const shared = { channel: connection.channel, processor, frameProcessor, reframeProcessor, log };
    consumers = [
      await startClipPrepareConsumer({ ...shared, queue: cfg.queues.clipPrepare, prefetch: cfg.prefetchByType.clipPrepare }),
      await startClipPrepareConsumer({ ...shared, queue: cfg.queues.frameExtract, prefetch: cfg.prefetchByType.frameExtract }),
      await startClipPrepareConsumer({ ...shared, queue: cfg.queues.reframeAnalyze, prefetch: cfg.prefetchByType.reframeAnalyze }),
      ...(fetchCfg.enabled ? [await startSocialFetchConsumer({ channel: connection.channel, queue: fetchCfg.queue, prefetch: fetchCfg.prefetch, processor: fetchProcessor, log })] : []),
    ];
    const composePrefetch = cfg.prefetchByType.compose ?? composeCfg.prefetch;
    renderConsumer = await startComposeConsumer({ channel: renderConnection.channel, queue: composeCfg.queue, prefetch: composePrefetch, processor: composeProcessor, log });
    log(
      `ready on queues ${cfg.queues.clipPrepare}(legacy, all types) + ${cfg.queues.frameExtract} + ${cfg.queues.reframeAnalyze} + ${composeCfg.queue}${fetchCfg.enabled ? ` + ${fetchCfg.queue}` : ""} (${brokerLabel}); ` +
        `prefetch clip=${cfg.prefetchByType.clipPrepare} frame=${cfg.prefetchByType.frameExtract} reframe=${cfg.prefetchByType.reframeAnalyze} compose=${composePrefetch} ffmpegThreads=${cfg.ffmpegThreads}; FFmpeg runs here only`,
    );
    await Promise.race([closed, new Promise<void>((r) => { wake = r; })]);
    if (stopping) {
      await Promise.all([...consumers.map((c) => c.drain()), renderConsumer.drain()]);
      await Promise.all([connection.close(), renderConnection.close()]);
    } else {
      await Promise.allSettled([connection.close(), renderConnection.close()]);
    }
    consumers = [];
    renderConsumer = null;
  }
  await detector.close();
  clearInterval(sweepTimer);
  log("stopped");
};

void bootstrap();
