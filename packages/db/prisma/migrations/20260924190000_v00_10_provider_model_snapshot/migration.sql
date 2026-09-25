-- V00-10: account-scoped model eligibility + freshness snapshot.
-- Additive only: no existing table/column is dropped or renamed.

-- AlterTable
ALTER TABLE "ProviderAccount" ADD COLUMN "modelSnapshot" JSONB;
