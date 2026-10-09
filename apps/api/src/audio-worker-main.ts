import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AudioWorkerModule } from "./audio-worker.module.js";
import { AudioVersionsService } from "./audio-versions.service.js";
import { PrismaService } from "./prisma.service.js";
import { startWorkerHeartbeat } from "./worker-health.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });

const bootstrap = async () => {
  const app = await NestFactory.createApplicationContext(AudioWorkerModule, { logger: ["error", "warn", "log"] });
  const audio = app.get(AudioVersionsService);
  console.info("LyOnix audio generation worker started (PostgreSQL durable queue)");
  // Liveness for GET /system/workers and the submit preflight.
  const stopHeartbeat = startWorkerHeartbeat(app.get(PrismaService), "audio");
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  while (!stopping) {
    try {
      const processed = await audio.processNext();
      if (!processed) await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
    } catch (error) {
      console.error("Audio worker loop failed; queued items remain durable", error instanceof Error ? error.message : "unknown error");
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 2000));
    }
  }
  stopHeartbeat();
  await app.close();
};

void bootstrap();
