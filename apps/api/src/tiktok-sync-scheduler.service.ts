import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ChannelsService } from "./channels.service.js";

/**
 * Periodic TikTok channel sync: every 5 minutes, calls `ChannelsService.syncAllConnected()`
 * once for the whole batch of `connected` channels (not once per channel per tick). Runs in
 * `apps/api` (chosen over `apps/worker` per explicit product decision — see chat 2026-09-24 —
 * trading the "HTTP process shouldn't run long-lived background loops" principle noted in
 * VE2E-05 for reusing `ChannelsService` directly instead of duplicating sync/token-refresh
 * logic across processes).
 */
@Injectable()
export class TiktokSyncSchedulerService {
  private readonly logger = new Logger(TiktokSyncSchedulerService.name);
  private running = false;

  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Cron("*/5 * * * *", { name: "tiktok-channel-sync" })
  async handleCron() {
    await this.runOnce();
  }

  /** Guards against overlap: if a tick is still running when the next one fires, skip it rather than syncing the same channel twice concurrently. */
  async runOnce() {
    if (this.running) {
      this.logger.warn("Skipped tick: previous TikTok sync batch still running");
      return null;
    }
    this.running = true;
    try {
      const result = await this.channels.syncAllConnected();
      this.logger.log(`TikTok sync batch: ${result.synced}/${result.total} synced, ${result.invalid} invalid, ${result.failed} failed`);
      return result;
    } finally {
      this.running = false;
    }
  }
}
