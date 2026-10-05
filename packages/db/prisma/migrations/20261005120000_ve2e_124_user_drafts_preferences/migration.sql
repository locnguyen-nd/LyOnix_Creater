-- VE2E-124: per-user drafts and creation defaults. New tables only; no existing column is touched.
CREATE TABLE "UserDraft" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "flowType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserCreationPreference" (
    "userId" UUID NOT NULL,
    "options" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCreationPreference_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "UserDraft_userId_flowType_key" ON "UserDraft"("userId", "flowType");

ALTER TABLE "UserDraft" ADD CONSTRAINT "UserDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserCreationPreference" ADD CONSTRAINT "UserCreationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
