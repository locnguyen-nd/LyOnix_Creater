/**
 * VE2E-62: queue visibility derived from existing rows (no new columns / no migration).
 *
 * - workflow: `WorkflowRun.status = draft` is the wait queue; the worker claims the oldest `createdAt` first
 *   (`WorkflowRunnerService.startNextDraft`), so `queuePosition` is the 1-based rank by (createdAt, id) among drafts.
 *   `active` = runs holding a worker slot (`source_ready..ready_to_render`); `limit` = `WORKFLOW_CONCURRENCY` (VE2E-61).
 *   Runs parked on the provider render (`render_queued|rendering|verifying|reconciling`) do not hold a slot.
 * - media: `RenderJob.status = preparing_clips` without a live preparation lease waits for clip preparation (FIFO by
 *   createdAt); with a live lease it is `active`; `limit` = media-worker prefetch (same formula as the worker config).
 * - render: provider-side. `active` = jobs submitted/at Creatomate (`accepted|rendering|verifying|reconciling`),
 *   `queued` = jobs Creatomate reports as `queued`; `limit` = `PROVIDER_CONCURRENCY_CREATOMATE` which only bounds OUR
 *   concurrent submits - the real Creatomate plan cap is not observable (honest limit).
 *
 * Counts are global (all users). Limits are read from this process' env; if the API and the worker processes are
 * configured with different env values the displayed limit is the API's.
 */
import { availableParallelism } from "node:os";
import { Inject, Injectable } from "@nestjs/common";
import type { QueueStateFields, QueueSummaryResponse } from "@lyonix/contracts";
import { resolveConcurrencyConfig } from "./concurrency-config.js";
import { PrismaService } from "./prisma.service.js";

export const WORKFLOW_ACTIVE_STATUSES = ["source_ready", "scripting", "awaiting_script_approval", "voice_generating", "aligning", "media_preparing", "editing", "ready_to_render"] as const;
export const RENDER_ACTIVE_STATUSES = ["accepted", "rendering", "verifying", "reconciling"] as const;

/** 1-based FIFO rank by (orderAt asc, id asc). Pure; ties are broken by id so two same-millisecond drafts never share a position. */
export const computeQueuePositions = (items: ReadonlyArray<{ id: string; orderAt: Date }>): Map<string, number> => {
  const sorted = [...items].sort((a, b) => a.orderAt.getTime() - b.orderAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.map((item, index) => [item.id, index + 1]));
};

/** Same rule as media-worker `loadMediaWorkerConfig`: MEDIA_WORKER_PREFETCH (default 3, 1..16) capped by the CPU count. */
export const resolveMediaPrefetch = (env: Record<string, string | undefined> = process.env, cpuCount: number = availableParallelism()): number => {
  const cpus = Math.max(1, Math.floor(cpuCount) || 1);
  const raw = env.MEDIA_WORKER_PREFETCH?.trim();
  const parsed = raw ? Number(raw) : 3;
  const value = Number.isInteger(parsed) && parsed >= 1 && parsed <= 16 ? parsed : 3;
  return Math.min(value, cpus);
};

/** Preparation lease still alive = a media-worker pass owns the job right now. */
const hasLiveLease = (row: { preparationLeaseUntil: Date | null }, now: Date) => row.preparationLeaseUntil !== null && row.preparationLeaseUntil.getTime() >= now.getTime();

const notQueued = (queuedAt: Date | null, startedAt: Date | null): QueueStateFields => ({ queuePosition: null, queuedAt: queuedAt?.toISOString() ?? null, startedAt: startedAt?.toISOString() ?? null });

@Injectable()
export class QueueStatusService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async summary(now: Date = new Date()): Promise<QueueSummaryResponse[]> {
    const config = resolveConcurrencyConfig();
    const [wfQueued, wfActive, prep, renderActive, renderQueued] = await Promise.all([
      this.prisma.workflowRun.count({ where: { mode: "auto", deletedAt: null, status: "draft" } }),
      this.prisma.workflowRun.count({ where: { mode: "auto", deletedAt: null, status: { in: [...WORKFLOW_ACTIVE_STATUSES] } } }),
      this.prisma.renderJob.findMany({ where: { status: "preparing_clips" }, select: { preparationLeaseUntil: true } }),
      this.prisma.renderJob.count({ where: { status: { in: [...RENDER_ACTIVE_STATUSES] } } }),
      this.prisma.renderJob.count({ where: { status: "queued" } }),
    ]);
    const mediaActive = prep.filter((row) => hasLiveLease(row, now)).length;
    return [
      { kind: "workflow", active: wfActive, limit: config.workflow, queued: wfQueued },
      { kind: "render", active: renderActive, limit: config.providerLimits.creatomate, queued: renderQueued },
      { kind: "media", active: mediaActive, limit: resolveMediaPrefetch(), queued: prep.length - mediaActive },
    ];
  }

  /**
   * Queue state for a set of Auto runs. Position is computed against ALL queued drafts (not only the passed rows),
   * so a run's #N is the same whether it comes from the list or the detail endpoint.
   */
  async workflowQueueStates(runs: ReadonlyArray<{ id: string; status: string; createdAt: Date; updatedAt: Date }>): Promise<Map<string, QueueStateFields>> {
    const result = new Map<string, QueueStateFields>();
    if (runs.length === 0) return result;
    const drafts = runs.some((run) => run.status === "draft")
      ? await this.prisma.workflowRun.findMany({ where: { mode: "auto", deletedAt: null, status: "draft" }, select: { id: true, createdAt: true } })
      : [];
    const positions = computeQueuePositions(drafts.map((row) => ({ id: row.id, orderAt: row.createdAt })));
    const startedIds = runs.filter((run) => run.status !== "draft").map((run) => run.id);
    const started = startedIds.length > 0
      ? await this.prisma.stepRun.groupBy({ by: ["workflowRunId"], where: { workflowRunId: { in: startedIds }, startedAt: { not: null } }, _min: { startedAt: true } })
      : [];
    const startedAt = new Map(started.map((row) => [row.workflowRunId, row._min.startedAt] as const));
    for (const run of runs) {
      if (run.status === "draft") {
        // updatedAt = when the run (re-)entered `draft` (submit or retry); the rank itself follows the worker's createdAt order.
        result.set(run.id, { queuePosition: positions.get(run.id) ?? null, queuedAt: run.updatedAt.toISOString(), startedAt: null });
      } else {
        result.set(run.id, notQueued(run.createdAt, startedAt.get(run.id) ?? null));
      }
    }
    return result;
  }

  /** Queue state of one render job (media queue while waiting for clip preparation, provider queue when Creatomate says `queued`). */
  async renderQueueState(row: { id: string; status: string; createdAt: Date; preparationLeaseUntil?: Date | null; submittedAt?: Date | null }, now: Date = new Date()): Promise<{ queueKind: "media" | "render" | null } & QueueStateFields> {
    const lease = row.preparationLeaseUntil ?? null;
    if (row.status === "preparing_clips" && !hasLiveLease({ preparationLeaseUntil: lease }, now)) {
      const waiting = (await this.prisma.renderJob.findMany({ where: { status: "preparing_clips", OR: [{ preparationLeaseUntil: null }, { preparationLeaseUntil: { lt: now } }] }, select: { id: true, createdAt: true } }))
        .map((job) => ({ id: job.id, orderAt: job.createdAt }));
      return { queueKind: "media", queuePosition: computeQueuePositions(waiting).get(row.id) ?? null, queuedAt: row.createdAt.toISOString(), startedAt: null };
    }
    if (row.status === "queued") {
      const waiting = (await this.prisma.renderJob.findMany({ where: { status: "queued" }, select: { id: true, createdAt: true } })).map((job) => ({ id: job.id, orderAt: job.createdAt }));
      return { queueKind: "render", queuePosition: computeQueuePositions(waiting).get(row.id) ?? null, queuedAt: (row.submittedAt ?? row.createdAt).toISOString(), startedAt: null };
    }
    return { queueKind: null, ...notQueued(row.createdAt, row.submittedAt ?? null) };
  }
}
