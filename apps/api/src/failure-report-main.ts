import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@lyonix/db";
import { failedStepCauses, formatReport, sloSummary, stepStats, summarizeMediaDiagnostics, summarizeRuns, topCauses, type FailureReport, type FailureRun } from "./failure-report.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

/**
 * VE2E-84: read-only failure baseline. `corepack pnpm --filter @lyonix/api report:failures -- --days=7 [--json]`.
 * Only findMany/groupBy; prints no user content (error messages are normalized/truncated, source text is never selected).
 */
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const days = Math.max(1, Number(daysArg?.split("=")[1]) || 7);
const asJson = process.argv.includes("--json");
const CONNECT_TIMEOUT_MS = 10_000;

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s (is the database running?)`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const main = async () => {
  const since = new Date(Date.now() - days * 86_400_000);
  const prisma = new PrismaClient();
  try {
    await withTimeout(prisma.$connect(), CONNECT_TIMEOUT_MS, "database connection");
    const rows = await prisma.workflowRun.findMany({
      where: { createdAt: { gte: since }, deletedAt: null },
      select: {
        id: true,
        status: true,
        attempts: true,
        createdAt: true,
        updatedAt: true,
        lastError: true,
        stepRuns: { select: { stepKey: true, status: true, attempt: true, error: true, startedAt: true, endedAt: true } },
        renderJobs: { where: { status: "completed" }, orderBy: { completedAt: "desc" }, take: 1, select: { completedAt: true } },
      },
    });
    const runs: FailureRun[] = rows.map((r) => {
      const starts = r.stepRuns.flatMap((s) => (s.startedAt ? [s.startedAt.getTime()] : []));
      return {
        id: r.id,
        status: r.status,
        attempts: r.attempts,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastError: r.lastError,
        renderedAt: r.renderJobs[0]?.completedAt ?? null,
        claimedAt: starts.length ? new Date(Math.min(...starts)) : null,
      };
    });
    const allSteps = rows.flatMap((r) => r.stepRuns);
    const diagnostics = await prisma.stepRun.findMany({ where: { stepKey: "media_plan_diagnostics", workflowRun: { createdAt: { gte: since }, deletedAt: null } }, select: { outputRef: true } });
    const jobs = await prisma.renderJob.groupBy({ by: ["engine", "status"], where: { createdAt: { gte: since } }, _count: { _all: true } });
    const renderJobsByEngine: Record<string, Record<string, number>> = {};
    for (const j of jobs) (renderJobsByEngine[j.engine] ??= {})[j.status] = j._count._all;

    const report: FailureReport = {
      windowDays: days,
      since: since.toISOString(),
      runs: summarizeRuns(runs),
      slo: sloSummary(runs),
      topRunCauses: topCauses(runs.filter((r) => ["failed", "needs_input", "blocked_provider"].includes(r.status) || r.attempts > 1).map((r) => r.lastError)),
      failedSteps: failedStepCauses(allSteps),
      steps: stepStats(allSteps.filter((s) => s.status === "succeeded" && s.startedAt && s.endedAt).map((s) => ({ stepKey: s.stepKey, startedAt: s.startedAt!, endedAt: s.endedAt! }))),
      renderJobsByEngine,
      media: summarizeMediaDiagnostics(diagnostics.map((d) => d.outputRef)),
    };
    console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
};

void main()
  .catch((error) => {
    console.error("failure report failed:", error instanceof Error ? (error.message.split("\n").filter(Boolean).pop() ?? "error") : "unknown error");
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
