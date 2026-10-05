-- VE2E-56: additive only (new table + nullable column).
ALTER TABLE "ProviderOperation" ADD COLUMN "modelId" TEXT;
ALTER TABLE "ProviderAccount" ADD COLUMN "preferredModels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "ProviderModelCooldown" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "modelId" TEXT NOT NULL,
    "cooldownUntil" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderModelCooldown_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderModelCooldown_providerAccountId_modelId_key" ON "ProviderModelCooldown"("providerAccountId", "modelId");
CREATE INDEX "ProviderModelCooldown_cooldownUntil_idx" ON "ProviderModelCooldown"("cooldownUntil");

ALTER TABLE "ProviderModelCooldown" ADD CONSTRAINT "ProviderModelCooldown_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
