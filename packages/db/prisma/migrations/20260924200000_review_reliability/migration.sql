CREATE TYPE "AudioGenerationOperationStatus" AS ENUM ('queued', 'processing', 'completed', 'failed', 'unknown');

CREATE TABLE "AuthRateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthRateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "AuthRateLimitBucket_resetAt_idx" ON "AuthRateLimitBucket"("resetAt");

CREATE TABLE "AudioGenerationOperation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sceneDraftVersionId" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "modelId" TEXT,
    "status" "AudioGenerationOperationStatus" NOT NULL DEFAULT 'queued',
    "errorCode" TEXT,
    "resultAudioVersionId" UUID,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AudioGenerationOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AudioGenerationOperation_resultAudioVersionId_key" ON "AudioGenerationOperation"("resultAudioVersionId");
CREATE UNIQUE INDEX "AudioGenerationOperation_userId_idempotencyKey_key" ON "AudioGenerationOperation"("userId", "idempotencyKey");
CREATE INDEX "AudioGenerationOperation_status_createdAt_idx" ON "AudioGenerationOperation"("status", "createdAt");

ALTER TABLE "AudioGenerationOperation" ADD CONSTRAINT "AudioGenerationOperation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudioGenerationOperation" ADD CONSTRAINT "AudioGenerationOperation_sceneDraftVersionId_fkey"
  FOREIGN KEY ("sceneDraftVersionId") REFERENCES "SceneDraftVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AudioGenerationOperation" ADD CONSTRAINT "AudioGenerationOperation_providerAccountId_fkey"
  FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AudioGenerationOperation" ADD CONSTRAINT "AudioGenerationOperation_resultAudioVersionId_fkey"
  FOREIGN KEY ("resultAudioVersionId") REFERENCES "AudioVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
