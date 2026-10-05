-- VE2E-19: per-channel finished video library thumbnail source.
-- Additive only: no existing table/column is dropped or renamed.

-- AlterTable
ALTER TABLE "RenderJob" ADD COLUMN "snapshotUrl" TEXT;
