import { describe, expect, it, vi } from "vitest";
import { TiktokSyncSchedulerService } from "./tiktok-sync-scheduler.service.js";
import type { ChannelsService } from "./channels.service.js";
import type { SystemSettingsService } from "./system-settings.service.js";
import type { SchedulerRegistry } from "@nestjs/schedule";

function makeScheduler(syncAllConnected: ReturnType<typeof vi.fn>) {
  const channels = { syncAllConnected } as unknown as ChannelsService;
  const settings = {
    load: vi.fn().mockResolvedValue({ channelSyncIntervalMinutes: 5 }),
  } as unknown as SystemSettingsService;
  const registry = {
    deleteInterval: vi.fn(),
    addInterval: vi.fn(),
  } as unknown as SchedulerRegistry;
  return new TiktokSyncSchedulerService(channels, settings, registry);
}

describe("TiktokSyncSchedulerService", () => {
  it("calls syncAllConnected once per tick and returns its summary", async () => {
    const syncAllConnected = vi.fn().mockResolvedValue({ total: 2, synced: 2, invalid: 0, failed: 0 });
    const scheduler = makeScheduler(syncAllConnected);

    const result = await scheduler.runOnce();

    expect(syncAllConnected).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 2, synced: 2, invalid: 0, failed: 0 });
  });

  it("skips an overlapping tick while a previous batch is still running", async () => {
    let resolveFirst: (value: { total: number; synced: number; invalid: number; failed: number }) => void = () => {};
    const first = new Promise<{ total: number; synced: number; invalid: number; failed: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const syncAllConnected = vi.fn().mockReturnValueOnce(first);
    const scheduler = makeScheduler(syncAllConnected);

    const firstRun = scheduler.runOnce();
    const secondRun = await scheduler.runOnce();

    expect(secondRun).toBeNull();
    expect(syncAllConnected).toHaveBeenCalledTimes(1);

    resolveFirst({ total: 0, synced: 0, invalid: 0, failed: 0 });
    await firstRun;
  });

  it("clears the running guard after a failed batch so the next tick can proceed", async () => {
    const syncAllConnected = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ total: 1, synced: 1, invalid: 0, failed: 0 });
    const scheduler = makeScheduler(syncAllConnected);

    await expect(scheduler.runOnce()).rejects.toThrow("boom");
    const second = await scheduler.runOnce();

    expect(second).toEqual({ total: 1, synced: 1, invalid: 0, failed: 0 });
  });
});
