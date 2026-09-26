import { Injectable, Logger } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SystemSettings = {
  /** Minutes between TikTok channel sync batches. Allowed: 1–60. Default 5. */
  channelSyncIntervalMinutes: number;
};

const DEFAULTS: SystemSettings = {
  channelSyncIntervalMinutes: 5,
};

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const settingsPath = () => resolve(repoRoot, process.env.SYSTEM_SETTINGS_PATH ?? "./data/system-settings.json");

const clampInterval = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.channelSyncIntervalMinutes;
  return Math.min(60, Math.max(1, Math.round(n)));
};

@Injectable()
export class SystemSettingsService {
  private readonly logger = new Logger(SystemSettingsService.name);
  private cached: SystemSettings = { ...DEFAULTS };

  async load(): Promise<SystemSettings> {
    try {
      const raw = await readFile(settingsPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<SystemSettings>;
      this.cached = {
        channelSyncIntervalMinutes: clampInterval(parsed.channelSyncIntervalMinutes),
      };
    } catch {
      this.cached = { ...DEFAULTS };
    }
    return { ...this.cached };
  }

  get(): SystemSettings {
    return { ...this.cached };
  }

  async update(patch: Partial<SystemSettings>): Promise<SystemSettings> {
    const next: SystemSettings = {
      channelSyncIntervalMinutes:
        patch.channelSyncIntervalMinutes === undefined
          ? this.cached.channelSyncIntervalMinutes
          : clampInterval(patch.channelSyncIntervalMinutes),
    };
    const path = settingsPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    this.cached = next;
    this.logger.log(`System settings updated: sync every ${next.channelSyncIntervalMinutes}m`);
    return { ...next };
  }

  /** Cron expression for the channel-sync job (e.g. every N minutes). */
  syncCronExpression(minutes = this.cached.channelSyncIntervalMinutes): string {
    const m = clampInterval(minutes);
    return m === 60 ? "0 * * * *" : `*/${m} * * * *`;
  }
}
