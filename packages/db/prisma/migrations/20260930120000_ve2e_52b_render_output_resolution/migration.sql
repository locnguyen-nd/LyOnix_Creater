-- VE2E-52b: additive, nullable (old jobs unaffected).
ALTER TABLE "RenderJob" ADD COLUMN "outputRenderScale" DOUBLE PRECISION,
ADD COLUMN "outputWidth" INTEGER,
ADD COLUMN "outputHeight" INTEGER,
ADD COLUMN "canvasWidth" INTEGER,
ADD COLUMN "canvasHeight" INTEGER;
