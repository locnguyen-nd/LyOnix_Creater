-- VE2E-07: Studio legacy-job bridge + persisted TimelineVersion.
-- Additive only: no existing table/column is dropped or renamed.
-- Baseline for this migration: `prisma migrate diff --from-empty --to-schema-datamodel`
-- run against schema.prisma as of this session (after VE2E-00/02/03/04/05, V00-10 and
-- VE2E-06's `20260925090000_ve2e_06_workflow_orchestrator` migration). If VE2E-06 lands
-- additional migrations after this one, Plan may need to reorder the migration chain -
-- this migration only adds the two new self-contained tables below and touches nothing
-- VE2E-06 owns.

-- CreateEnum
CREATE TYPE "TimelineVersionStatus" AS ENUM ('draft', 'approved');

-- CreateTable
CREATE TABLE "StudioProjectBridge" (
    "productionRequestId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceVersionId" UUID NOT NULL,
    "scriptDraftVersionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioProjectBridge_pkey" PRIMARY KEY ("productionRequestId")
);

-- CreateTable
CREATE TABLE "TimelineVersion" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "TimelineVersionStatus" NOT NULL DEFAULT 'draft',
    "templateSnapshotId" UUID,
    "scenes" JSONB NOT NULL,
    "optionValues" JSONB NOT NULL DEFAULT '{}',
    "supersedesId" UUID,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" UUID,

    CONSTRAINT "TimelineVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudioProjectBridge_projectId_key" ON "StudioProjectBridge"("projectId");

-- CreateIndex
CREATE INDEX "TimelineVersion_projectId_status_idx" ON "TimelineVersion"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TimelineVersion_projectId_version_key" ON "TimelineVersion"("projectId", "version");
