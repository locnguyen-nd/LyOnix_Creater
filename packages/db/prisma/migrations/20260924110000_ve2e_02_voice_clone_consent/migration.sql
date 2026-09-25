-- VE2E-02: ElevenLabs Instant Voice Clone consent audit.
-- Additive only: no existing table/column is dropped or renamed.

-- CreateTable
CREATE TABLE "VoiceCloneConsentRecord" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "externalVoiceId" TEXT,
    "voiceName" TEXT NOT NULL,
    "statementVersion" TEXT NOT NULL,
    "statementText" TEXT NOT NULL,
    "sampleChecksums" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "attestedByUserId" UUID NOT NULL,
    "attestedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,

    CONSTRAINT "VoiceCloneConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VoiceCloneConsentRecord_providerAccountId_externalVoiceId_idx" ON "VoiceCloneConsentRecord"("providerAccountId", "externalVoiceId");

-- AddForeignKey
ALTER TABLE "VoiceCloneConsentRecord" ADD CONSTRAINT "VoiceCloneConsentRecord_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceCloneConsentRecord" ADD CONSTRAINT "VoiceCloneConsentRecord_attestedByUserId_fkey" FOREIGN KEY ("attestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceCloneConsentRecord" ADD CONSTRAINT "VoiceCloneConsentRecord_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
