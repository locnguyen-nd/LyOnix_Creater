import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@lyonix/db";
import { buildTimingReport, formatTimingReport } from "./timing-report.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

/**
 * Read-only stage timing of one Auto run and its render: `corepack pnpm --filter @lyonix/api report:timing -- <runId|prefix> [--json]`.
 * Without an id: the latest run. Prints no user content (no narration, URLs, secrets), only stage keys, providers, codes and durations.
 */
const asJson = process.argv.includes("--json");
const idArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

const main = async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (create .env from .env.example); nothing was queried");
  const prisma = new PrismaClient();
  try {
    const candidates = await prisma.workflowRun.findMany({ orderBy: { createdAt: "desc" }, take: 200, select: { id: true, status: true, attempts: true, createdAt: true } });
    const run = idArg ? candidates.find((row) => row.id.startsWith(idArg)) : candidates[0];
    if (!run) throw new Error(idArg ? `No workflow run starting with "${idArg}"` : "No workflow run yet");
    const [steps, operations, renders] = await Promise.all([
      prisma.stepRun.findMany({ where: { workflowRunId: run.id, attempt: run.attempts }, select: { id: true, stepKey: true, status: true, attempt: true, startedAt: true, endedAt: true, outputRef: true, error: true } }),
      prisma.providerOperation.findMany({ where: { workflowRunId: run.id }, select: { stepRunId: true, providerAccountId: true, status: true, errorCode: true } }),
      prisma.renderJob.findMany({ where: { workflowRunId: run.id }, orderBy: { createdAt: "asc" }, select: { id: true, engine: true, status: true, createdAt: true, submittedAt: true, completedAt: true, renderDurationMs: true, clipsTotal: true, lastError: true } }),
    ]);
    const accountIds = [...new Set(operations.map((row) => row.providerAccountId).filter((id): id is string => Boolean(id)))];
    const accounts = await prisma.providerAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, provider: true } });
    const stepKeyById = new Map(steps.map((step) => [step.id, step.stepKey]));
    const report = buildTimingReport({
      run,
      steps,
      operations: operations.map((row) => ({ stepKey: row.stepRunId ? stepKeyById.get(row.stepRunId) ?? null : null, provider: accounts.find((account) => account.id === row.providerAccountId)?.provider ?? null, status: row.status, errorCode: row.errorCode })),
      renders: renders.map((row) => ({ ...row, errorCode: row.lastError && typeof row.lastError === "object" && typeof (row.lastError as { code?: unknown }).code === "string" ? (row.lastError as { code: string }).code : null })),
    });
    console.log(asJson ? JSON.stringify(report, null, 2) : formatTimingReport(report));
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "timing report failed");
  process.exitCode = 1;
});
