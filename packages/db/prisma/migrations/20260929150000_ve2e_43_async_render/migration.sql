ALTER TYPE "RenderJobStatus" ADD VALUE IF NOT EXISTS 'preparing_clips';

ALTER TABLE "RenderJob"
  ADD COLUMN "clipsTotal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "clipsReady" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "clipFailures" JSONB,
  ADD COLUMN "preparationLeaseUntil" TIMESTAMP(3);

CREATE INDEX "RenderJob_status_preparationLeaseUntil_idx" ON "RenderJob"("status", "preparationLeaseUntil");
