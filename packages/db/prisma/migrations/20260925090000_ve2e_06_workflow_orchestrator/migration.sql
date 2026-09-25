-- VE2E-06: one-click AutomationProfile orchestrator support columns.
-- Additive only: no existing table/column is dropped or renamed.

-- AlterTable
ALTER TABLE "AutomationProfileVersion" ADD COLUMN "mediaConfig" JSONB;
ALTER TABLE "AutomationProfileVersion" ADD COLUMN "renderConfig" JSONB;

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WorkflowRun" ADD COLUMN "lastError" JSONB;
