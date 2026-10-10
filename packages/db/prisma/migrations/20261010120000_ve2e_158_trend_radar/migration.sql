-- VE2E-158 Trend Radar: config, runs, topics (clusters) + source items + snapshots, staff assignments, AI usage counters, in-app notifications.
-- Additive only: no existing table or row is changed.
-- CreateTable
CREATE TABLE "TrendRadarConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "yahooEnabled" BOOLEAN NOT NULL DEFAULT false,
    "yahooCategories" JSONB NOT NULL DEFAULT '["japan","sports","entertainment","trending"]',
    "tiktokEnabled" BOOLEAN NOT NULL DEFAULT false,
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "hashtags" JSONB NOT NULL DEFAULT '[]',
    "categories" JSONB NOT NULL DEFAULT '[]',
    "windowHours" INTEGER NOT NULL DEFAULT 48,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 45,
    "thresholds" JSONB NOT NULL DEFAULT '{"hot":80,"rising":60,"review":40}',
    "notifyMinScore" INTEGER NOT NULL DEFAULT 60,
    "tiktokMaxQueries" INTEGER NOT NULL DEFAULT 4,
    "tiktokResultsPerQuery" INTEGER NOT NULL DEFAULT 15,
    "tiktokMinViews" INTEGER NOT NULL DEFAULT 0,
    "analysisAccountId" UUID,
    "autoAnalysisPerDay" INTEGER NOT NULL DEFAULT 5,
    "analysisPerDay" INTEGER NOT NULL DEFAULT 15,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrendRadarConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendRun" (
    "id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedByUserId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "sources" JSONB NOT NULL DEFAULT '[]',
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "clusterCount" INTEGER NOT NULL DEFAULT 0,
    "notifiedCount" INTEGER NOT NULL DEFAULT 0,
    "analysedCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendCluster" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER NOT NULL DEFAULT 0,
    "band" TEXT NOT NULL DEFAULT 'low',
    "scoreBreakdown" JSONB NOT NULL DEFAULT '{}',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analysis" JSONB,
    "analysisStatus" TEXT NOT NULL DEFAULT 'none',
    "analysisError" TEXT,
    "analysisModel" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "notifiedBands" JSONB NOT NULL DEFAULT '[]',
    "productionRefs" JSONB NOT NULL DEFAULT '[]',
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrendCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendItem" (
    "id" UUID NOT NULL,
    "clusterId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "author" TEXT,
    "publisher" TEXT,
    "excerpt" TEXT,
    "thumbnailUrl" TEXT,
    "hashtags" JSONB NOT NULL DEFAULT '[]',
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT,
    "publishedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB,
    "completeness" TEXT NOT NULL,
    "importedByUserId" UUID,

    CONSTRAINT "TrendItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendItemSnapshot" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "TrendItemSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendClusterSnapshot" (
    "id" UUID NOT NULL,
    "clusterId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,

    CONSTRAINT "TrendClusterSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendAssignment" (
    "id" UUID NOT NULL,
    "clusterId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "angleIndex" INTEGER,
    "angleTitle" TEXT,
    "assignedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendAiUsage" (
    "id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrendAiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrendRun_createdAt_idx" ON "TrendRun"("createdAt");

-- CreateIndex
CREATE INDEX "TrendRun_status_idx" ON "TrendRun"("status");

-- CreateIndex
CREATE INDEX "TrendCluster_score_idx" ON "TrendCluster"("score");

-- CreateIndex
CREATE INDEX "TrendCluster_lastSeenAt_idx" ON "TrendCluster"("lastSeenAt");

-- CreateIndex
CREATE INDEX "TrendCluster_status_idx" ON "TrendCluster"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TrendItem_canonicalUrl_key" ON "TrendItem"("canonicalUrl");

-- CreateIndex
CREATE INDEX "TrendItem_clusterId_idx" ON "TrendItem"("clusterId");

-- CreateIndex
CREATE INDEX "TrendItem_collectedAt_idx" ON "TrendItem"("collectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrendItem_provider_sourceId_key" ON "TrendItem"("provider", "sourceId");

-- CreateIndex
CREATE INDEX "TrendItemSnapshot_itemId_measuredAt_idx" ON "TrendItemSnapshot"("itemId", "measuredAt");

-- CreateIndex
CREATE INDEX "TrendClusterSnapshot_clusterId_measuredAt_idx" ON "TrendClusterSnapshot"("clusterId", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrendAssignment_clusterId_userId_key" ON "TrendAssignment"("clusterId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrendAiUsage_day_model_kind_key" ON "TrendAiUsage"("day", "model", "kind");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "TrendItem" ADD CONSTRAINT "TrendItem_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "TrendCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendItemSnapshot" ADD CONSTRAINT "TrendItemSnapshot_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "TrendItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendClusterSnapshot" ADD CONSTRAINT "TrendClusterSnapshot_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "TrendCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendAssignment" ADD CONSTRAINT "TrendAssignment_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "TrendCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendAssignment" ADD CONSTRAINT "TrendAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
