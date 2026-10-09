-- Render reliability (additive):
-- 1. WorkerHeartbeat: each background worker process (workflow, audio) upserts its row every few seconds, so the API can tell
--    "worker not running" BEFORE a job is submitted instead of the job sitting in `draft` for minutes.
-- 2. WorkflowRun.notBefore: a retryable failure re-queues the run no earlier than this (provider Retry-After / cooldown, else
--    bounded exponential backoff), so a run is never retried ~1 s later into a cooldown that is still active.
ALTER TABLE "WorkflowRun" ADD COLUMN "notBefore" TIMESTAMP(3);
CREATE INDEX "WorkflowRun_status_notBefore_idx" ON "WorkflowRun"("status", "notBefore");

CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "info" JSONB,
    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkerHeartbeat_kind_lastSeenAt_idx" ON "WorkerHeartbeat"("kind", "lastSeenAt");
