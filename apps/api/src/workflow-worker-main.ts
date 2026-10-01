import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { WorkflowWorkerModule } from "./workflow-worker.module.js";
import { WorkflowRunnerService } from "./workflow-runner.service.js";
import { RenderJobsService } from "./render-jobs.service.js";
import { resolveConcurrencyConfig } from "./concurrency-config.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });

/**
 * VE2E-06: separate background process for the Auto AutomationProfile orchestrator —
 * `POST /video-productions` only enqueues a `WorkflowRun` row and returns `202`; this
 * process is what actually calls every provider (content/tts/visual/render), the same
 * "durable queue + separate worker loop" shape `audio-worker-main.ts` already
 * established for TTS. Never runs FFmpeg (no media-worker code here) and never runs
 * inside `apps/api`'s HTTP request path.
 */
const bootstrap = async () => {
  const app = await NestFactory.createApplicationContext(WorkflowWorkerModule, { logger: ["error", "warn", "log"] });
  const runner = app.get(WorkflowRunnerService);
  const renders = app.get(RenderJobsService);
  // VE2E-61: keep up to WORKFLOW_CONCURRENCY runs in flight; provider calls are additionally bounded by the shared
  // per-provider limiter (concurrency-config.ts), so many runs never exceed a provider's concurrent ceiling.
  const concurrency = resolveConcurrencyConfig();
  for (const warning of concurrency.warnings) console.warn(`[concurrency] ${warning}`);
  console.info(
    `LyOnix video-production workflow worker started (PostgreSQL durable WorkflowRun queue; workflow=${concurrency.workflow}, voiceParallelism=${concurrency.voiceParallelism}, providers=${JSON.stringify(concurrency.providerLimits)})`,
  );
  const inflight = new Set<Promise<void>>();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  while (!stopping) {
    try {
      const prepared = await renders.processNextPreparation();
      const started = await runner.fillSlots(inflight, concurrency.workflow);
      await runner.reconcile();
      // Nothing new was started: wait for a running run to finish, or 1s (poll queue + parked renders), instead of spinning.
      if (started === 0 && !prepared) await Promise.race([...inflight, new Promise((resolveSleep) => setTimeout(resolveSleep, 1000))]);
    } catch (error) {
      console.error("Workflow worker loop failed; run state remains durable", error instanceof Error ? error.message : "unknown error");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
    }
  }
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
  await app.close();
};

void bootstrap();
