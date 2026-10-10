-- Additive: the channel chosen on the create form is stored on the run, so the per-channel video library can list Auto runs next to
-- Studio videos. Existing rows stay NULL (they were never tied to a channel); deleting a channel only clears the link.
ALTER TABLE "WorkflowRun" ADD COLUMN "channelId" UUID;
CREATE INDEX "WorkflowRun_channelId_status_idx" ON "WorkflowRun"("channelId", "status");
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
