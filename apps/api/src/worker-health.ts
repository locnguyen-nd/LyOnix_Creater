import { hostname } from "node:os";
import type { Prisma } from "@lyonix/db";
import type { PrismaService } from "./prisma.service.js";

/**
 * Render reliability: liveness of the background workers. `workflow` (Auto pipeline + render preparation) and `audio` (TTS queue)
 * upsert a `WorkerHeartbeat` row every {@link HEARTBEAT_INTERVAL_MS}; the media-worker (FFmpeg) is seen through its RabbitMQ
 * consumers. A worker whose newest beat is older than {@link HEARTBEAT_STALE_MS} is reported down, so the UI and the submit
 * preflight say "worker is not running" instead of a job sitting in `draft` for minutes.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_STALE_MS = 35_000;

export type HeartbeatKind = "workflow" | "audio";
export type WorkerState = { up: boolean; lastSeenAt: string | null; ageMs: number | null };
export type WorkerHealth = {
  checkedAt: string;
  workflow: WorkerState;
  audio: WorkerState;
  /** `null` = RabbitMQ could not be asked (broker down / not configured). */
  mediaWorker: { up: boolean | null; consumers: number | null };
  /** Every problem in the user's language; empty = all workers running. */
  problems: string[];
};

type HeartbeatStore = Pick<PrismaService, "workerHeartbeat">;

export function startWorkerHeartbeat(prisma: HeartbeatStore, kind: HeartbeatKind, info: Record<string, unknown> = {}, now: () => Date = () => new Date()): () => void {
  const host = hostname().slice(0, 64);
  const id = `${kind}@${host}#${process.pid}`;
  const startedAt = now();
  const beat = async () => {
    const at = now();
    try {
      await prisma.workerHeartbeat.upsert({
        where: { id },
        create: { id, kind, host, pid: process.pid, startedAt, lastSeenAt: at, info: info as Prisma.InputJsonValue },
        update: { lastSeenAt: at, info: info as Prisma.InputJsonValue },
      });
      // Rows of processes that stopped long ago only add noise.
      await prisma.workerHeartbeat.deleteMany({ where: { lastSeenAt: { lt: new Date(at.getTime() - 24 * 60 * 60_000) } } });
    } catch {
      // A missed beat only makes the worker look down for a moment; it must never stop the worker.
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    void prisma.workerHeartbeat.deleteMany({ where: { id } }).catch(() => undefined);
  };
}

const stateOf = (lastSeenAt: Date | null, now: Date): WorkerState => {
  if (!lastSeenAt) return { up: false, lastSeenAt: null, ageMs: null };
  const ageMs = Math.max(0, now.getTime() - lastSeenAt.getTime());
  return { up: ageMs <= HEARTBEAT_STALE_MS, lastSeenAt: lastSeenAt.toISOString(), ageMs };
};

export const WORKER_PROBLEMS = {
  workflow: "Worker xử lý video (apps/worker › workflow) không chạy: job sẽ nằm chờ ở hàng đợi. Chạy `corepack pnpm --filter @lyonix/worker dev` rồi thử lại.",
  audio: "Worker giọng đọc (apps/worker › audio) không chạy: tạo giọng trong Studio sẽ không chạy.",
  mediaWorker: "Media-worker (FFmpeg) không chạy: cắt clip và render LyOnix không chạy được.",
  broker: "Không kết nối được RabbitMQ để kiểm tra media-worker.",
} as const;

export async function readWorkerHealth(
  prisma: HeartbeatStore,
  renderQueueStatus: (() => Promise<{ consumers: number } | null>) | null,
  now: Date = new Date(),
): Promise<WorkerHealth> {
  const rows = await prisma.workerHeartbeat.findMany({ where: { kind: { in: ["workflow", "audio"] } }, select: { kind: true, lastSeenAt: true } }).catch(() => []);
  const newest = (kind: HeartbeatKind) => rows.filter((row) => row.kind === kind).reduce<Date | null>((max, row) => (!max || row.lastSeenAt > max ? row.lastSeenAt : max), null);
  const workflow = stateOf(newest("workflow"), now);
  const audio = stateOf(newest("audio"), now);
  const queue = renderQueueStatus ? await renderQueueStatus().catch(() => null) : null;
  const mediaWorker = { up: queue ? queue.consumers > 0 : null, consumers: queue ? queue.consumers : null };
  const problems: string[] = [];
  if (!workflow.up) problems.push(WORKER_PROBLEMS.workflow);
  if (!audio.up) problems.push(WORKER_PROBLEMS.audio);
  if (mediaWorker.up === false) problems.push(WORKER_PROBLEMS.mediaWorker);
  if (mediaWorker.up === null) problems.push(WORKER_PROBLEMS.broker);
  return { checkedAt: now.toISOString(), workflow, audio, mediaWorker, problems };
}
