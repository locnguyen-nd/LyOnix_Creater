-- VE2E-04: Pexels media import + simple scene assignment on MediaAssetVersion.
-- Additive only: no existing table/column is dropped or renamed.

-- AlterTable
ALTER TABLE "MediaAssetVersion" ADD COLUMN "sceneId" TEXT;

-- CreateIndex
CREATE INDEX "MediaAssetVersion_projectId_sceneId_idx" ON "MediaAssetVersion"("projectId", "sceneId");
