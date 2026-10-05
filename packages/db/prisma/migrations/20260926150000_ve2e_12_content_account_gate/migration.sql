-- VE2E-12: shared API/worker admission count and provider cooldown for content accounts.
ALTER TABLE "ProviderAccount"
  ADD COLUMN "activeContentRequests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cooldownUntil" TIMESTAMP(3);

ALTER TABLE "ProviderAccount"
  ADD CONSTRAINT "ProviderAccount_activeContentRequests_nonnegative"
  CHECK ("activeContentRequests" >= 0);

CREATE INDEX "ProviderAccount_role_status_cooldownUntil_idx"
  ON "ProviderAccount"("role", "status", "cooldownUntil");
