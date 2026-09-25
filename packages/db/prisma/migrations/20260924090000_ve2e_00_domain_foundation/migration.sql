-- VE2E-00: Auto/Studio E2E domain foundation.
-- Additive only: no existing table/column is dropped or renamed.

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('topic', 'raw_script', 'article_url', 'file');
CREATE TYPE "SourceFetchStatus" AS ENUM ('pending', 'fetched', 'extracted', 'failed', 'blocked');
CREATE TYPE "MediaAssetKind" AS ENUM ('image', 'video', 'audio', 'document');
CREATE TYPE "MediaOrigin" AS ENUM ('upload', 'import_url', 'generated', 'pexels');
CREATE TYPE "RetentionClass" AS ENUM ('project', 'working');
CREATE TYPE "WorkflowRunMode" AS ENUM ('auto', 'studio');
CREATE TYPE "WorkflowRunStatus" AS ENUM (
  'draft', 'source_ready', 'scripting', 'awaiting_script_approval', 'voice_generating',
  'aligning', 'media_preparing', 'editing', 'ready_to_render', 'render_queued', 'rendering',
  'verifying', 'completed', 'blocked_provider', 'needs_input', 'failed', 'cancelled', 'reconciling'
);
CREATE TYPE "StepRunStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');
CREATE TYPE "ProviderOperationStatus" AS ENUM ('pending', 'in_progress', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdByUserId" UUID NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProjectGrant" (
    "userId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    CONSTRAINT "UserProjectGrant_pkey" PRIMARY KEY ("userId", "projectId")
);

-- CreateTable
CREATE TABLE "TeamProject" (
    "teamId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    CONSTRAINT "TeamProject_pkey" PRIMARY KEY ("teamId", "projectId")
);

-- CreateTable
CREATE TABLE "MediaFolder" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MediaFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAssetVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "folderId" UUID,
    "kind" "MediaAssetKind" NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "widthPx" INTEGER,
    "heightPx" INTEGER,
    "durationMs" INTEGER,
    "origin" "MediaOrigin" NOT NULL,
    "license" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "reusable" BOOLEAN NOT NULL DEFAULT true,
    "retentionClass" "RetentionClass" NOT NULL DEFAULT 'working',
    "relativePath" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" UUID,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "MediaAssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "type" "SourceType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentId" UUID,
    "originRef" TEXT,
    "rawText" TEXT,
    "extractedText" TEXT,
    "checksumSha256" TEXT,
    "fetchStatus" "SourceFetchStatus" NOT NULL DEFAULT 'pending',
    "fetchError" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    CONSTRAINT "SourceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationProfileVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentConfig" JSONB NOT NULL,
    "voiceConfig" JSONB NOT NULL,
    "mediaPolicy" TEXT NOT NULL DEFAULT 'project_library_then_pexels',
    "templateSnapshotRef" TEXT,
    "brandOptions" JSONB NOT NULL DEFAULT '{}',
    "outputPreset" JSONB NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'vi',
    "durationSec" INTEGER NOT NULL,
    "sceneCount" INTEGER NOT NULL,
    "costCeilingAmount" DECIMAL(12,4) NOT NULL,
    "costCeilingCurrency" TEXT NOT NULL DEFAULT 'USD',
    "retryPolicy" JSONB NOT NULL DEFAULT '{}',
    "accountFallbackAllowlist" JSONB NOT NULL DEFAULT '[]',
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationProfileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "mode" "WorkflowRunMode" NOT NULL,
    "automationProfileVersionId" UUID,
    "sourceVersionId" UUID,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'draft',
    "requestFingerprint" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepRun" (
    "id" UUID NOT NULL,
    "workflowRunId" UUID NOT NULL,
    "stepKey" TEXT NOT NULL,
    "status" "StepRunStatus" NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "inputRef" JSONB,
    "outputRef" JSONB,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StepRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderOperation" (
    "id" UUID NOT NULL,
    "workflowRunId" UUID,
    "stepRunId" UUID,
    "providerAccountId" UUID,
    "role" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" "ProviderOperationStatus" NOT NULL DEFAULT 'pending',
    "externalRequestId" TEXT,
    "correlationId" TEXT NOT NULL,
    "costAmount" DECIMAL(12,4),
    "costCurrency" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaDeliveryToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mediaAssetVersionId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "workflowRunId" UUID,
    "createdByUserId" UUID,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MediaDeliveryToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaFolder_projectId_parentId_idx" ON "MediaFolder"("projectId", "parentId");
CREATE INDEX "MediaAssetVersion_projectId_checksumSha256_idx" ON "MediaAssetVersion"("projectId", "checksumSha256");
CREATE INDEX "MediaAssetVersion_projectId_retentionClass_expiresAt_idx" ON "MediaAssetVersion"("projectId", "retentionClass", "expiresAt");
CREATE INDEX "SourceVersion_projectId_createdAt_idx" ON "SourceVersion"("projectId", "createdAt");
CREATE INDEX "AutomationProfileVersion_projectId_name_version_idx" ON "AutomationProfileVersion"("projectId", "name", "version");
CREATE UNIQUE INDEX "WorkflowRun_requestFingerprint_key" ON "WorkflowRun"("requestFingerprint");
CREATE INDEX "WorkflowRun_projectId_status_idx" ON "WorkflowRun"("projectId", "status");
CREATE UNIQUE INDEX "StepRun_workflowRunId_stepKey_attempt_key" ON "StepRun"("workflowRunId", "stepKey", "attempt");
CREATE INDEX "ProviderOperation_workflowRunId_role_idx" ON "ProviderOperation"("workflowRunId", "role");
CREATE INDEX "ProviderOperation_correlationId_idx" ON "ProviderOperation"("correlationId");
CREATE UNIQUE INDEX "MediaDeliveryToken_tokenHash_key" ON "MediaDeliveryToken"("tokenHash");
CREATE INDEX "MediaDeliveryToken_mediaAssetVersionId_idx" ON "MediaDeliveryToken"("mediaAssetVersionId");
CREATE INDEX "MediaDeliveryToken_expiresAt_idx" ON "MediaDeliveryToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserProjectGrant" ADD CONSTRAINT "UserProjectGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserProjectGrant" ADD CONSTRAINT "UserProjectGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamProject" ADD CONSTRAINT "TeamProject_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamProject" ADD CONSTRAINT "TeamProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaFolder" ADD CONSTRAINT "MediaFolder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaFolder" ADD CONSTRAINT "MediaFolder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MediaFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAssetVersion" ADD CONSTRAINT "MediaAssetVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAssetVersion" ADD CONSTRAINT "MediaAssetVersion_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "MediaFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MediaAssetVersion" ADD CONSTRAINT "MediaAssetVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MediaAssetVersion" ADD CONSTRAINT "MediaAssetVersion_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "MediaAssetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SourceVersion" ADD CONSTRAINT "SourceVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceVersion" ADD CONSTRAINT "SourceVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceVersion" ADD CONSTRAINT "SourceVersion_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "SourceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AutomationProfileVersion" ADD CONSTRAINT "AutomationProfileVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationProfileVersion" ADD CONSTRAINT "AutomationProfileVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_automationProfileVersionId_fkey" FOREIGN KEY ("automationProfileVersionId") REFERENCES "AutomationProfileVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StepRun" ADD CONSTRAINT "StepRun_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderOperation" ADD CONSTRAINT "ProviderOperation_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderOperation" ADD CONSTRAINT "ProviderOperation_stepRunId_fkey" FOREIGN KEY ("stepRunId") REFERENCES "StepRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaDeliveryToken" ADD CONSTRAINT "MediaDeliveryToken_mediaAssetVersionId_fkey" FOREIGN KEY ("mediaAssetVersionId") REFERENCES "MediaAssetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaDeliveryToken" ADD CONSTRAINT "MediaDeliveryToken_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MediaDeliveryToken" ADD CONSTRAINT "MediaDeliveryToken_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
