import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@lyonix/db";

config({ path: resolve(process.cwd(), "../../.env") });
config({ path: resolve(process.cwd(), "../../.env.local"), override: true });
const db = new PrismaClient();
try {
  const runs = await db.workflowRun.findMany({ where: { mode: "auto", deletedAt: null }, orderBy: { createdAt: "desc" }, take: 8,
    select: { id: true, status: true, createdAt: true, attempts: true, lastError: true, automationProfileVersion: { select: { contentConfig: true, mediaConfig: true } }, stepRuns: { select: { stepKey: true, status: true, outputRef: true, error: true }, orderBy: { createdAt: "asc" } } } });
  for (const run of runs) {
    const contentConfig = run.automationProfileVersion?.contentConfig as { providerAccountId?: string } | null;
    const account = contentConfig?.providerAccountId ? await db.providerAccount.findUnique({ where: { id: contentConfig.providerAccountId }, select: { provider: true, status: true, model: true } }) : null;
    const diagnostics = run.stepRuns.find((step) => step.stepKey === "keyword_extraction_diagnostics")?.outputRef as { requested?: unknown[]; extracted?: unknown[]; failed?: string; reason?: string } | null;
    const media = run.stepRuns.find((step) => step.stepKey === "media_plan_diagnostics")?.outputRef as { segments?: Array<{ sourceProvider?: string; fallbackReason?: string }> } | null;
    const usage = run.stepRuns.find((step) => step.stepKey === "run_usage")?.outputRef as { entries?: Array<{ step?: string; provider?: string; modelId?: string }> } | null;
    const scriptPlan = run.stepRuns.find((step) => step.stepKey === "script_visual_plan_diagnostics")?.outputRef as Record<string, unknown> | null;
    console.log(JSON.stringify({ createdAt: run.createdAt, status: run.status, attempts: run.attempts, account, hasExtractStep: run.stepRuns.some((step) => step.stepKey === "extract_keywords"), diagnostics: diagnostics ? { requestedCount: diagnostics.requested?.length, extractedCount: diagnostics.extracted?.length, failed: diagnostics.failed, reason: diagnostics.reason } : null, scriptPlanDiagnostics: scriptPlan ? { keys: Object.keys(scriptPlan), reason: scriptPlan.reason, valid: scriptPlan.valid } : null, media: media?.segments?.map((segment) => ({ provider: segment.sourceProvider, fallbackReason: segment.fallbackReason })), usage: usage?.entries?.filter((entry) => entry.step === "extract_keywords"), steps: run.stepRuns.map((step) => `${step.stepKey}:${step.status}`) }));
  }
} finally { await db.$disconnect(); }
