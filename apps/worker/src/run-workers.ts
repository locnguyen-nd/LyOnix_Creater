import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * VE2E-21: `apps/worker` is the single package `pnpm dev` / `pnpm start` launches for
 * every durable background worker loop LyOnix has today. Before this file existed,
 * `apps/worker`'s `dev`/`start` scripts only ever delegated to `@lyonix/api`'s
 * `worker:audio` script (the ElevenLabs TTS queue, VE2E-02/03) — the Auto
 * video-production DAG orchestrator (`worker:workflow`, VE2E-06,
 * `apps/api/src/workflow-worker-main.ts`) was never started by the standard dev/deploy
 * path. Result: `POST /video-productions` only writes a `WorkflowRun` row and returns
 * `202`; without `worker:workflow` actually running, every Auto job sat at
 * `draft`/`queued` forever unless someone manually ran
 * `corepack pnpm --filter @lyonix/api worker:workflow` in a separate terminal.
 *
 * This script spawns both worker loops as separate child processes (same
 * one-process-per-worker-type shape `apps/api/src/audio-worker-main.ts` and
 * `workflow-worker-main.ts` already establish — durable PostgreSQL-queue polling, no
 * FFmpeg, never inside the HTTP request path) so a plain `pnpm dev` at the repo root
 * makes Auto jobs actually progress through real step history, with zero extra manual
 * commands.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "../../api");

interface WorkerSpec {
  readonly name: string;
  readonly script: "worker:audio" | "worker:workflow";
}

const workers: readonly WorkerSpec[] = [
  { name: "audio", script: "worker:audio" },
  { name: "workflow", script: "worker:workflow" },
];

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

function launch(spec: WorkerSpec): ChildProcess {
  // `shell: true` lets the OS shell resolve `corepack` (`.cmd` on Windows) the same
  // way a developer typing the command in a terminal would — no hardcoded extension.
  const child = spawn("corepack", ["pnpm", "run", spec.script], {
    cwd: apiDir,
    stdio: "inherit",
    shell: true,
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[worker:${spec.name}] exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"}); stopping all workers`,
    );
    shutdown(code && code !== 0 ? code : 1);
  });
  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error(`[worker:${spec.name}] failed to start`, error instanceof Error ? error.message : error);
    shutdown(1);
  });
  return child;
}

for (const spec of workers) {
  children.push(launch(spec));
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
