import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { TrendRadarService } from "./trend-radar.service.js";

const JOB_NAME = "trend-radar";
/** How often the scheduler looks whether a run is due (the run interval itself is the configured `intervalMinutes`, default 45). */
export const TREND_RADAR_TICK_MS = 60_000;

/**
 * VE2E-158: periodic Trend Radar runs through the existing @nestjs/schedule registry (same pattern as the TikTok channel sync) - no second
 * job system. Every minute it ASKS for a scheduled run; `TrendRadarService.requestRun` decides under its advisory lock (due by the
 * configured interval, nothing active, at least one runnable source), so a changed interval applies at once, several API replicas never
 * double a run, and with no source enabled nothing is called. `TREND_RADAR_SCHEDULER=0` switches the ticker off (tests, one-off scripts).
 */
@Injectable()
export class TrendRadarSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TrendRadarSchedulerService.name);
  private ticking = false;

  constructor(
    @Inject(TrendRadarService) private readonly radar: TrendRadarService,
    @Inject(SchedulerRegistry) private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env.TREND_RADAR_SCHEDULER === "0") {
      this.logger.log("Trend Radar scheduler off (TREND_RADAR_SCHEDULER=0)");
      return;
    }
    const handle = setInterval(() => void this.tick(), TREND_RADAR_TICK_MS);
    this.registry.addInterval(JOB_NAME, handle);
  }

  onModuleDestroy(): void {
    try {
      this.registry.deleteInterval(JOB_NAME);
    } catch {
      /* never added */
    }
  }

  /** One scheduler tick; overlapping ticks are skipped. Returns why a run did or did not start (tests / logs). */
  async tick(): Promise<string> {
    if (this.ticking) return "tick_in_progress";
    this.ticking = true;
    try {
      const outcome = await this.radar.requestRun("schedule", null);
      if (outcome.started) this.logger.log(`Trend Radar scheduled run ${outcome.run?.id} started`);
      return outcome.reason;
    } catch (error) {
      this.logger.warn(`Trend Radar tick failed: ${error instanceof Error ? error.message : String(error)}`);
      return "error";
    } finally {
      this.ticking = false;
    }
  }
}
