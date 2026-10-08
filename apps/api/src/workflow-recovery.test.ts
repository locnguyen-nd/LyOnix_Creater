import { describe, expect, it, vi } from "vitest";
import { WorkflowRunnerService } from "./workflow-runner.service.js";

const recover = (stale: Array<{ id: string; attempts: number }>) => {
  const prisma = {
    workflowRun: { findMany: vi.fn(async () => stale), updateMany: vi.fn(async () => ({ count: 1 })) },
    stepRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    providerOperation: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const service = Object.create(WorkflowRunnerService.prototype) as WorkflowRunnerService;
  (service as unknown as { prisma: typeof prisma }).prisma = prisma;
  return { prisma, run: () => service.recoverStaleRuns(new Date("2026-10-08T00:00:00Z")) };
};

describe("recoverStaleRuns (VE2E-139)", () => {
  it("re-queues an orphaned run and fails its dangling steps/operations", async () => {
    const { prisma, run } = recover([{ id: "r1", attempts: 1 }]);
    expect(await run()).toBe(1);
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "draft", attempts: { increment: 1 } }) }));
    expect(prisma.stepRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workflowRunId: "r1", status: "running" } }));
    expect(prisma.providerOperation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "failed", errorCode: "WORKER_LOST" } }));
  });

  it("fails the run visibly after repeated worker losses instead of looping", async () => {
    const { prisma, run } = recover([{ id: "r2", attempts: 3 }]);
    await run();
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }));
  });

  it("does nothing when no run is stale", async () => {
    const { prisma, run } = recover([]);
    expect(await run()).toBe(0);
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });
});
