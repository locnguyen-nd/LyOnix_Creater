import { describe, expect, it } from "vitest";
import { QueueStatusService, computeQueuePositions, resolveMediaPrefetch } from "./queue-status.service.js";

const at = (iso: string) => new Date(iso);

describe("VE2E-62 queue positions", () => {
  it("ranks FIFO by (orderAt, id) with 1-based positions and breaks same-millisecond ties by id", () => {
    const positions = computeQueuePositions([
      { id: "c", orderAt: at("2026-10-01T10:00:02Z") },
      { id: "b", orderAt: at("2026-10-01T10:00:01Z") },
      { id: "a", orderAt: at("2026-10-01T10:00:01Z") },
    ]);
    expect(positions.get("a")).toBe(1);
    expect(positions.get("b")).toBe(2);
    expect(positions.get("c")).toBe(3);
  });

  it("returns nothing for an empty queue", () => {
    expect(computeQueuePositions([]).size).toBe(0);
  });
});

describe("VE2E-62 media prefetch limit", () => {
  it("defaults to 3 capped by the CPU count, mirrors the media-worker rule, and ignores invalid values", () => {
    expect(resolveMediaPrefetch({}, 8)).toBe(3);
    expect(resolveMediaPrefetch({}, 2)).toBe(2);
    expect(resolveMediaPrefetch({ MEDIA_WORKER_PREFETCH: "5" }, 8)).toBe(5);
    expect(resolveMediaPrefetch({ MEDIA_WORKER_PREFETCH: "5" }, 4)).toBe(4);
    expect(resolveMediaPrefetch({ MEDIA_WORKER_PREFETCH: "0" }, 8)).toBe(3);
    expect(resolveMediaPrefetch({ MEDIA_WORKER_PREFETCH: "abc" }, 8)).toBe(3);
    expect(resolveMediaPrefetch({ MEDIA_WORKER_PREFETCH: "99" }, 8)).toBe(3);
  });
});

type Row = Record<string, any>;

const fakePrisma = (data: { runs?: Row[]; renders?: Row[]; steps?: Row[] }) => {
  const runs = data.runs ?? [];
  const renders = data.renders ?? [];
  const inStatus = (status: any, value: string) => (typeof status === "string" ? status === value : (status?.in ?? []).includes(value));
  return {
    workflowRun: {
      count: async ({ where }: any) => runs.filter((row) => row.mode === where.mode && !row.deletedAt && inStatus(where.status, row.status)).length,
      findMany: async ({ where }: any) => runs.filter((row) => row.mode === where.mode && !row.deletedAt && inStatus(where.status, row.status)),
    },
    renderJob: {
      count: async ({ where }: any) => renders.filter((row) => inStatus(where.status, row.status)).length,
      findMany: async ({ where }: any) =>
        renders.filter((row) => {
          if (!inStatus(where.status, row.status)) return false;
          if (!where.OR) return true;
          const now = where.OR[1].preparationLeaseUntil.lt as Date;
          return row.preparationLeaseUntil === null || row.preparationLeaseUntil < now;
        }),
    },
    stepRun: {
      groupBy: async ({ where }: any) =>
        (data.steps ?? [])
          .filter((row) => where.workflowRunId.in.includes(row.workflowRunId))
          .map((row) => ({ workflowRunId: row.workflowRunId, _min: { startedAt: row.startedAt } })),
    },
  };
};

describe("VE2E-62 QueueStatusService", () => {
  const run = (id: string, status: string, createdAt: string): Row => ({ id, mode: "auto", deletedAt: null, status, createdAt: at(createdAt), updatedAt: at(createdAt) });

  it("gives each waiting draft its FIFO position and none to runs that already hold a worker slot", async () => {
    const prisma = fakePrisma({
      runs: [run("r1", "draft", "2026-10-01T10:00:01Z"), run("r2", "draft", "2026-10-01T10:00:02Z"), run("r3", "voice_generating", "2026-10-01T09:00:00Z")],
      steps: [{ workflowRunId: "r3", startedAt: at("2026-10-01T09:01:00Z") }],
    });
    const service = new QueueStatusService(prisma as any);
    const states = await service.workflowQueueStates([
      { id: "r1", status: "draft", createdAt: at("2026-10-01T10:00:01Z"), updatedAt: at("2026-10-01T10:00:01Z") },
      { id: "r2", status: "draft", createdAt: at("2026-10-01T10:00:02Z"), updatedAt: at("2026-10-01T10:00:02Z") },
      { id: "r3", status: "voice_generating", createdAt: at("2026-10-01T09:00:00Z"), updatedAt: at("2026-10-01T09:30:00Z") },
    ]);
    expect(states.get("r1")).toMatchObject({ queuePosition: 1, startedAt: null });
    expect(states.get("r2")).toMatchObject({ queuePosition: 2, startedAt: null });
    expect(states.get("r3")).toMatchObject({ queuePosition: null, startedAt: "2026-10-01T09:01:00.000Z" });
  });

  it("computes the same position from the detail endpoint (single run) as from the list", async () => {
    const prisma = fakePrisma({ runs: [run("r1", "draft", "2026-10-01T10:00:01Z"), run("r2", "draft", "2026-10-01T10:00:02Z")] });
    const service = new QueueStatusService(prisma as any);
    const only = await service.workflowQueueStates([{ id: "r2", status: "draft", createdAt: at("2026-10-01T10:00:02Z"), updatedAt: at("2026-10-01T10:00:02Z") }]);
    expect(only.get("r2")?.queuePosition).toBe(2);
  });

  it("moves later runs up once an earlier one is cancelled", async () => {
    const runs = [run("r1", "draft", "2026-10-01T10:00:01Z"), run("r2", "draft", "2026-10-01T10:00:02Z")];
    const service = new QueueStatusService(fakePrisma({ runs }) as any);
    const input = [{ id: "r2", status: "draft", createdAt: at("2026-10-01T10:00:02Z"), updatedAt: at("2026-10-01T10:00:02Z") }];
    expect((await service.workflowQueueStates(input)).get("r2")?.queuePosition).toBe(2);
    runs[0]!.status = "cancelled";
    expect((await service.workflowQueueStates(input)).get("r2")?.queuePosition).toBe(1);
  });

  it("reports a render job waiting for clip preparation in the media queue, and a live-lease one as running", async () => {
    const now = at("2026-10-01T10:10:00Z");
    const prisma = fakePrisma({
      renders: [
        { id: "j1", status: "preparing_clips", createdAt: at("2026-10-01T10:00:00Z"), preparationLeaseUntil: null },
        { id: "j2", status: "preparing_clips", createdAt: at("2026-10-01T10:00:05Z"), preparationLeaseUntil: at("2026-10-01T10:05:00Z") },
        { id: "j3", status: "preparing_clips", createdAt: at("2026-10-01T10:00:09Z"), preparationLeaseUntil: at("2026-10-01T10:20:00Z") },
      ],
    });
    const service = new QueueStatusService(prisma as any);
    expect(await service.renderQueueState({ id: "j2", status: "preparing_clips", createdAt: at("2026-10-01T10:00:05Z"), preparationLeaseUntil: at("2026-10-01T10:05:00Z") }, now)).toMatchObject({ queueKind: "media", queuePosition: 2 });
    expect(await service.renderQueueState({ id: "j3", status: "preparing_clips", createdAt: at("2026-10-01T10:00:09Z"), preparationLeaseUntil: at("2026-10-01T10:20:00Z") }, now)).toMatchObject({ queueKind: null, queuePosition: null });
  });

  it("reports provider-queued jobs in the render queue and everything else as not waiting", async () => {
    const prisma = fakePrisma({
      renders: [
        { id: "q1", status: "queued", createdAt: at("2026-10-01T10:00:00Z") },
        { id: "q2", status: "queued", createdAt: at("2026-10-01T10:00:03Z") },
      ],
    });
    const service = new QueueStatusService(prisma as any);
    expect(await service.renderQueueState({ id: "q2", status: "queued", createdAt: at("2026-10-01T10:00:03Z"), submittedAt: at("2026-10-01T10:00:04Z") })).toMatchObject({ queueKind: "render", queuePosition: 2, queuedAt: "2026-10-01T10:00:04.000Z" });
    expect(await service.renderQueueState({ id: "x", status: "rendering", createdAt: at("2026-10-01T10:00:00Z"), submittedAt: at("2026-10-01T10:00:01Z") })).toMatchObject({ queueKind: null, queuePosition: null, startedAt: "2026-10-01T10:00:01.000Z" });
  });

  it("summarises active / limit / queued for workflow, render and media", async () => {
    const prisma = fakePrisma({
      runs: [run("r1", "draft", "2026-10-01T10:00:01Z"), run("r2", "voice_generating", "2026-10-01T10:00:02Z"), run("r3", "media_preparing", "2026-10-01T10:00:03Z")],
      renders: [
        { id: "j1", status: "rendering", createdAt: at("2026-10-01T10:00:00Z") },
        { id: "j2", status: "queued", createdAt: at("2026-10-01T10:00:01Z") },
        { id: "j3", status: "preparing_clips", createdAt: at("2026-10-01T10:00:02Z"), preparationLeaseUntil: null, },
      ],
    });
    const summary = await new QueueStatusService(prisma as any).summary(at("2026-10-01T10:10:00Z"));
    const byKind = Object.fromEntries(summary.map((item) => [item.kind, item]));
    expect(byKind.workflow).toMatchObject({ active: 2, queued: 1 });
    expect(byKind.render).toMatchObject({ active: 1, queued: 1 });
    expect(byKind.media).toMatchObject({ active: 0, queued: 1 });
    expect(byKind.workflow!.limit).toBeGreaterThanOrEqual(1);
  });
});
