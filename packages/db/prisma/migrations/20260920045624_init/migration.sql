-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'staff');

-- CreateEnum
CREATE TYPE "ProviderScope" AS ENUM ('personal', 'organization');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('unverified', 'verified', 'failed', 'disabled');

-- CreateEnum
CREATE TYPE "ChannelAuthType" AS ENUM ('oauth2', 'token', 'api_key', 'fixture');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('accepted', 'scripting', 'awaiting_staff_ack', 'producing', 'handoff_workspace_ready', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "uiLocale" TEXT NOT NULL DEFAULT 'vi',
    "theme" TEXT NOT NULL DEFAULT 'system',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderAccount" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scope" "ProviderScope" NOT NULL,
    "ownerUserId" UUID,
    "status" "ProviderStatus" NOT NULL DEFAULT 'unverified',
    "model" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "isFake" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "externalChannelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "authType" "ChannelAuthType" NOT NULL,
    "encryptedSecret" TEXT,
    "grantedScopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'connected',
    "isFixture" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "id" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "metricName" TEXT NOT NULL,
    "value" DECIMAL(20,4),
    "currency" TEXT,
    "availability" TEXT NOT NULL,
    "reasonCode" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionRequest" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'accepted',
    "inputFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptVersion" (
    "id" UUID NOT NULL,
    "productionRequestId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubtitleCue" (
    "id" UUID NOT NULL,
    "scriptVersionId" UUID NOT NULL,
    "cueIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "startMs" INTEGER,
    "endMs" INTEGER,

    CONSTRAINT "SubtitleCue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAsset" (
    "id" UUID NOT NULL,
    "scriptVersionId" UUID NOT NULL,
    "sceneIndex" INTEGER NOT NULL,
    "relativePath" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "WorkflowAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoffWorkspace" (
    "id" UUID NOT NULL,
    "productionRequestId" UUID NOT NULL,
    "timelineVersionId" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoffWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "ProviderAccount_ownerUserId_scope_idx" ON "ProviderAccount"("ownerUserId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_userId_externalChannelId_key" ON "ChannelConnection"("userId", "externalChannelId");

-- CreateIndex
CREATE INDEX "MetricSnapshot_channelId_metricName_capturedAt_idx" ON "MetricSnapshot"("channelId", "metricName", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionRequest_inputFingerprint_key" ON "ProductionRequest"("inputFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptVersion_productionRequestId_version_key" ON "ScriptVersion"("productionRequestId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SubtitleCue_scriptVersionId_cueIndex_key" ON "SubtitleCue"("scriptVersionId", "cueIndex");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAsset_scriptVersionId_sceneIndex_key" ON "WorkflowAsset"("scriptVersionId", "sceneIndex");

-- CreateIndex
CREATE UNIQUE INDEX "HandoffWorkspace_fingerprint_key" ON "HandoffWorkspace"("fingerprint");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderAccount" ADD CONSTRAINT "ProviderAccount_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricSnapshot" ADD CONSTRAINT "MetricSnapshot_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_productionRequestId_fkey" FOREIGN KEY ("productionRequestId") REFERENCES "ProductionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubtitleCue" ADD CONSTRAINT "SubtitleCue_scriptVersionId_fkey" FOREIGN KEY ("scriptVersionId") REFERENCES "ScriptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAsset" ADD CONSTRAINT "WorkflowAsset_scriptVersionId_fkey" FOREIGN KEY ("scriptVersionId") REFERENCES "ScriptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffWorkspace" ADD CONSTRAINT "HandoffWorkspace_productionRequestId_fkey" FOREIGN KEY ("productionRequestId") REFERENCES "ProductionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
