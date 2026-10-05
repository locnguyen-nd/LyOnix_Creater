-- VE2E-03: persisted ScriptDraftVersion/SceneDraftVersion (ScriptDraftV2 finally
-- persisted, tied to SourceVersion) + AudioVersion/SubtitleVersion (real ElevenLabs
-- audio + character alignment persisted and versioned, timed captions derived from the
-- real alignment). Additive only -- no existing table/column/enum is touched.
--
-- Named ScriptDraftVersion/SceneDraftVersion (not ScriptVersion/SceneVersion) to avoid
-- colliding with the pre-existing legacy `ScriptVersion` model (Vrew-era
-- ProductionRequest workflow, unrelated and untouched by this migration).

-- CreateEnum
CREATE TYPE "ScriptVersionStatus" AS ENUM ('draft', 'approved');

-- CreateEnum
CREATE TYPE "AudioVersionStatus" AS ENUM ('current', 'stale');

-- CreateEnum
CREATE TYPE "SubtitleVersionStatus" AS ENUM ('current', 'stale');

-- CreateTable
CREATE TABLE "ScriptDraftVersion" (
    "id" UUID NOT NULL,
    "sourceVersionId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ScriptVersionStatus" NOT NULL DEFAULT 'draft',
    "schemaVersion" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "providerPin" JSONB NOT NULL,
    "supersedesId" UUID,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "ScriptDraftVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneDraftVersion" (
    "id" UUID NOT NULL,
    "scriptDraftVersionId" UUID NOT NULL,
    "sceneId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "narration" TEXT NOT NULL,
    "screenText" TEXT NOT NULL,
    "visualQuery" TEXT NOT NULL,
    "durationHintMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneDraftVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioVersion" (
    "id" UUID NOT NULL,
    "sceneDraftVersionId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "AudioVersionStatus" NOT NULL DEFAULT 'current',
    "providerAccountId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalVoiceId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "textChecksumSha256" TEXT NOT NULL,
    "mediaAssetVersionId" UUID NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "alignment" JSONB NOT NULL,
    "supersedesId" UUID,
    "staleAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubtitleVersion" (
    "id" UUID NOT NULL,
    "audioVersionId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "SubtitleVersionStatus" NOT NULL DEFAULT 'current',
    "source" TEXT NOT NULL DEFAULT 'elevenlabs_alignment',
    "segments" JSONB NOT NULL,
    "staleAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubtitleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScriptDraftVersion_sourceVersionId_status_idx" ON "ScriptDraftVersion"("sourceVersionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptDraftVersion_sourceVersionId_version_key" ON "ScriptDraftVersion"("sourceVersionId", "version");

-- CreateIndex
CREATE INDEX "SceneDraftVersion_scriptDraftVersionId_orderIndex_idx" ON "SceneDraftVersion"("scriptDraftVersionId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "SceneDraftVersion_scriptDraftVersionId_sceneId_key" ON "SceneDraftVersion"("scriptDraftVersionId", "sceneId");

-- CreateIndex
CREATE INDEX "AudioVersion_sceneDraftVersionId_status_idx" ON "AudioVersion"("sceneDraftVersionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AudioVersion_sceneDraftVersionId_version_key" ON "AudioVersion"("sceneDraftVersionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SubtitleVersion_audioVersionId_version_key" ON "SubtitleVersion"("audioVersionId", "version");

-- AddForeignKey
ALTER TABLE "ScriptDraftVersion" ADD CONSTRAINT "ScriptDraftVersion_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "SourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptDraftVersion" ADD CONSTRAINT "ScriptDraftVersion_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "ScriptDraftVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptDraftVersion" ADD CONSTRAINT "ScriptDraftVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneDraftVersion" ADD CONSTRAINT "SceneDraftVersion_scriptDraftVersionId_fkey" FOREIGN KEY ("scriptDraftVersionId") REFERENCES "ScriptDraftVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioVersion" ADD CONSTRAINT "AudioVersion_sceneDraftVersionId_fkey" FOREIGN KEY ("sceneDraftVersionId") REFERENCES "SceneDraftVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioVersion" ADD CONSTRAINT "AudioVersion_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioVersion" ADD CONSTRAINT "AudioVersion_mediaAssetVersionId_fkey" FOREIGN KEY ("mediaAssetVersionId") REFERENCES "MediaAssetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioVersion" ADD CONSTRAINT "AudioVersion_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "AudioVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioVersion" ADD CONSTRAINT "AudioVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubtitleVersion" ADD CONSTRAINT "SubtitleVersion_audioVersionId_fkey" FOREIGN KEY ("audioVersionId") REFERENCES "AudioVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubtitleVersion" ADD CONSTRAINT "SubtitleVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
