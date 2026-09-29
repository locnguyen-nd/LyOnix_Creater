-- AlterEnum
ALTER TYPE "MediaOrigin" ADD VALUE 'apify';

-- AlterTable
ALTER TABLE "MediaAssetVersion" ADD COLUMN     "parentMediaAssetVersionId" UUID,
ADD COLUMN     "transform" JSONB;

-- AlterTable
ALTER TABLE "TimelineVersion" ADD COLUMN     "segments" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "workflowRunId" UUID;

-- CreateIndex
CREATE INDEX "MediaAssetVersion_parentMediaAssetVersionId_idx" ON "MediaAssetVersion"("parentMediaAssetVersionId");

-- CreateIndex
CREATE INDEX "TimelineVersion_workflowRunId_idx" ON "TimelineVersion"("workflowRunId");

-- AddForeignKey
ALTER TABLE "MediaAssetVersion" ADD CONSTRAINT "MediaAssetVersion_parentMediaAssetVersionId_fkey" FOREIGN KEY ("parentMediaAssetVersionId") REFERENCES "MediaAssetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

