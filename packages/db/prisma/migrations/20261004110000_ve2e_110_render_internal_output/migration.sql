-- VE2E-110: additive columns for the internal (`lyonix`) render engine's output. Adds columns only.
ALTER TABLE "RenderJob" ADD COLUMN "outputRelativePath" TEXT,
ADD COLUMN "outputSha256" TEXT,
ADD COLUMN "outputBytes" INTEGER,
ADD COLUMN "outputProfileVersion" TEXT,
ADD COLUMN "thumbnailRelativePath" TEXT,
ADD COLUMN "qcReport" JSONB;
