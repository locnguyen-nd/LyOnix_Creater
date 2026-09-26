import { describe, expect, it } from "vitest";
import { SystemSettingsService } from "./system-settings.service.js";

describe("SystemSettingsService", () => {
  it("builds cron expressions for common intervals", () => {
    const svc = new SystemSettingsService();
    expect(svc.syncCronExpression(5)).toBe("*/5 * * * *");
    expect(svc.syncCronExpression(1)).toBe("*/1 * * * *");
    expect(svc.syncCronExpression(15)).toBe("*/15 * * * *");
    expect(svc.syncCronExpression(60)).toBe("0 * * * *");
  });

  it("clamps out-of-range intervals when building cron expressions", () => {
    const svc = new SystemSettingsService();
    expect(svc.syncCronExpression(0)).toBe("*/1 * * * *");
    expect(svc.syncCronExpression(999)).toBe("0 * * * *");
  });
});
