ALTER TABLE "ProviderAccount" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "ProviderAccount_ownerUserId_scope_deletedAt_idx"
  ON "ProviderAccount"("ownerUserId", "scope", "deletedAt");
