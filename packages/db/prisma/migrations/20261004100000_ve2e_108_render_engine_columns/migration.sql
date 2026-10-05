-- VE2E-108: additive render-engine columns (internal FFmpeg `lyonix` engine, Render Router, fallback). Adds columns/indexes only.
ALTER TABLE "TemplateSnapshot" ADD COLUMN "engine" TEXT NOT NULL DEFAULT 'creatomate',
ADD COLUMN "fallbackSnapshotIds" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "rolloutPercent" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "RenderJob" ADD COLUMN "engine" TEXT NOT NULL DEFAULT 'creatomate',
ADD COLUMN "routeReason" TEXT,
ADD COLUMN "fallbackOfJobId" UUID;

-- Backfill the new column of legacy rows from the provider that already rendered them (Orshot jobs keep their engine).
UPDATE "TemplateSnapshot" ts SET "engine" = pa."provider" FROM "ProviderAccount" pa WHERE pa."id" = ts."providerAccountId" AND pa."provider" = 'orshot';
UPDATE "RenderJob" rj SET "engine" = pa."provider" FROM "ProviderAccount" pa WHERE pa."id" = rj."providerAccountId" AND pa."provider" = 'orshot';

CREATE INDEX "RenderJob_engine_createdAt_idx" ON "RenderJob"("engine", "createdAt");
CREATE INDEX "RenderJob_fallbackOfJobId_idx" ON "RenderJob"("fallbackOfJobId");
