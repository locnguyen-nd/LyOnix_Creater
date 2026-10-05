import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { ChannelsService } from "./channels.service.js";
import { SystemSettingsService } from "./system-settings.service.js";

const JOB_NAME = "tiktok-channel-sync";

/**
 * Periodic TikTok channel sync. Interval comes from SystemSettings (default 5 min)
 * and can be changed at runtime via PATCH /system-settings without restarting the API.
 */
@Injectable()
export class TiktokSyncSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(TiktokSyncSchedulerService.name);
  private running = false;

  constructor(
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(SystemSettingsService) private readonly settings: SystemSettingsService,
    @Inject(SchedulerRegistry) private readonly registry: SchedulerRegistry,
  ) {}

  async onModuleInit() {
    const loaded = await this.settings.load();
    this.reschedule(loaded.channelSyncIntervalMinutes);
  }

  /** Replace the named interval timer with a new period derived from `minutes`. */
  reschedule(minutes: number) {
    const clamped = Math.min(60, Math.max(1, Math.round(minutes)));
    try {
      this.registry.deleteInterval(JOB_NAME);
    } catch {
      /* interval may not exist yet on first boot */
    }
    const handle = setInterval(() => {
      void this.handleCron();
    }, clamped * 60_000);
    this.registry.addInterval(JOB_NAME, handle);
    this.logger.log(`TikTok channel sync interval set to every ${clamped}m`);
  }

  async handleCron() {
    await this.runOnce();
  }

  /** Guards against overlap: if a tick is still running when the next one fires, skip it. */
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
