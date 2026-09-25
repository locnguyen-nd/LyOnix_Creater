-- VE2E-05: Creatomate template snapshot + render lifecycle.
-- Additive only: no existing table/column is dropped or renamed.

-- CreateEnum
CREATE TYPE "RenderJobStatus" AS ENUM ('accepted', 'queued', 'rendering', 'verifying', 'completed', 'failed', 'cancelled', 'reconciling', 'blocked_provider');

-- CreateTable
CREATE TABLE "TemplateSnapshot" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "externalTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "previewUrl" TEXT,
    "modifications" JSONB NOT NULL,
    "rawTemplate" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TemplateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderJob" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "templateSnapshotId" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "workflowRunId" UUID,
    "requestFingerprint" TEXT NOT NULL,
    "webhookToken" TEXT NOT NULL,
    "status" "RenderJobStatus" NOT NULL DEFAULT 'accepted',
    "externalJobId" TEXT,
    "modificationsPayload" JSONB NOT NULL,
    "progress" INTEGER,
    "resultUrl" TEXT,
    "resultExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" JSONB,
    "costAmount" DECIMAL(12,4),
    "costCurrency" TEXT,
    "renderDurationMs" INTEGER,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderWebhookEvent" (
    "id" UUID NOT NULL,
    "renderJobId" UUID NOT NULL,
    "eventFingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedStatus" TEXT,
    CONSTRAINT "RenderWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TemplateSnapshot_externalTemplateId_idx" ON "TemplateSnapshot"("externalTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_requestFingerprint_key" ON "RenderJob"("requestFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_webhookToken_key" ON "RenderJob"("webhookToken");

-- CreateIndex
CREATE INDEX "RenderJob_projectId_status_idx" ON "RenderJob"("projectId", "status");

-- CreateIndex
CREATE INDEX "RenderJob_externalJobId_idx" ON "RenderJob"("externalJobId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderWebhookEvent_eventFingerprint_key" ON "RenderWebhookEvent"("eventFingerprint");

-- CreateIndex
CREATE INDEX "RenderWebhookEvent_renderJobId_idx" ON "RenderWebhookEvent"("renderJobId");

-- AddForeignKey
ALTER TABLE "TemplateSnapshot" ADD CONSTRAINT "TemplateSnapshot_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateSnapshot" ADD CONSTRAINT "TemplateSnapshot_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_templateSnapshotId_fkey" FOREIGN KEY ("templateSnapshotId") REFERENCES "TemplateSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderWebhookEvent" ADD CONSTRAINT "RenderWebhookEvent_renderJobId_fkey" FOREIGN KEY ("renderJobId") REFERENCES "RenderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
