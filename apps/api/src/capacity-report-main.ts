import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@lyonix/db";
import { endToEnd, requiredConcurrency, stepDurations } from "./capacity-report.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

/**
 * Read-only capacity report from the real DB: `corepack pnpm --filter @lyonix/api report:capacity -- --hours=168`.
 * Prints p50/p95 per Auto step and end-to-end/render latency so provider caps and WORKFLOW_CONCURRENCY are sized from measurements
 * (DEC-2026-10-02-CAPACITY-250: do not raise defaults without numbers). Never writes. Dev-DB numbers do not replace a VPS-class load test.
 */
const hoursArg = process.argv.find((arg) => arg.startsWith("--hours="));
const hours = Math.max(1, Number(hoursArg?.split("=")[1]) || 168);
const since = new Date(Date.now() - hours * 3_600_000);
const fmt = (n: number) => n.toFixed(1).padStart(8);

const main = async () => {
  const prisma = new PrismaClient();
  try {
    const steps = await prisma.stepRun.findMany({ where: { status: "succeeded", startedAt: { not: null, gte: since }, endedAt: { not: null } }, select: { stepKey: true, startedAt: true, endedAt: true } });
    const stats = stepDurations(steps.map((s) => ({ stepKey: s.stepKey, startedAt: s.startedAt!, endedAt: s.endedAt! })));
    console.log(`Window: last ${hours}h (since ${since.toISOString()}), ${steps.length} succeeded step rows\n`);
    console.log("step".padEnd(28) + "     n     p50s     p95s     maxs");
    for (const [key, s] of Object.entries(stats).sort((a, b) => b[1].p95 - a[1].p95)) {
      console.log(key.padEnd(28) + String(s.count).padStart(6) + fmt(s.p50) + fmt(s.p95) + fmt(s.max));
    }
    const runs = await prisma.workflowRun.findMany({
      where: { status: "completed", createdAt: { gte: since } },
      select: {
        id: true,
        createdAt: true,
        attempts: true,
        stepRuns: { where: { startedAt: { not: null }, endedAt: { not: null } }, select: { stepKey: true, startedAt: true, endedAt: true } },
        renderJobs: { where: { status: "completed" }, orderBy: { completedAt: "desc" }, take: 1, select: { completedAt: true, submittedAt: true, renderDurationMs: true } },
      },
    });
    const e2e = endToEnd(
      runs.map((r) => ({
        runId: r.id,
        createdAt: r.createdAt,
        attempts: r.attempts,
        renderedAt: r.renderJobs[0]?.completedAt ?? null,
        renderSubmittedAt: r.renderJobs[0]?.submittedAt ?? null,
        renderDurationMs: r.renderJobs[0]?.renderDurationMs ?? null,
        steps: r.stepRuns.map((s) => ({ stepKey: s.stepKey, startedAt: s.startedAt!, endedAt: s.endedAt! })),
      })),
    );
    const sec = (n: number) => `${n.toFixed(0)}s`;
    const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(0)}%`);
    console.log(`\nFirst-attempt, uninterrupted runs: n=${e2e.considered} (excluded ${e2e.excluded} retried/paused)`);
    console.log(`  Pipeline until render submitted (script+voice+media+timeline): p50 ${sec(e2e.pipelineSec.p50)}  p95 ${sec(e2e.pipelineSec.p95)}  max ${sec(e2e.pipelineSec.max)}  (n=${e2e.pipelineSec.count})  <- reliable`);
    console.log(`  Submit -> MP4 recorded as ready: p50 ${sec(e2e.activeSec.p50 - e2e.pipelineSec.p50)} (indicative only: RenderJob.completedAt needs a webhook/poll, which a local machine without PUBLIC_BASE_URL reachability does not get on time)`);
    console.log(`  Queue wait (accepted -> first step):   p50 ${sec(e2e.queueWaitSec.p50)}  p95 ${sec(e2e.queueWaitSec.p95)}  (dev data includes hours with the worker stopped)`);
    console.log(`  Creatomate render time (n=${e2e.renderSec.count}): p50 ${sec(e2e.renderSec.p50)}  p95 ${sec(e2e.renderSec.p95)}`);
    if (e2e.pipelineSec.count > 0) console.log(`  Runs in flight needed for 200 videos/h at (pipeline p95 + render p50): ${requiredConcurrency(200, e2e.pipelineSec.p95 + e2e.renderSec.p50)}`);
    const byStatus = await prisma.renderJob.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } });
    console.log(`\nRender jobs by status: ${byStatus.map((f) => `${f.status}=${f._count._all}`).join("  ") || "none"}`);
  } finally {
    await prisma.$disconnect();
  }
};

void main().catch((error) => {
  console.error("capacity report failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
