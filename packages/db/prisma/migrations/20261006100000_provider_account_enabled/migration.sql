-- Additive: on/off switch per provider account (used for pexels/apify media sources); existing rows stay enabled.
ALTER TABLE "ProviderAccount" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
