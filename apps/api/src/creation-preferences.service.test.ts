import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreationPreferencesService } from "./creation-preferences.service.js";

type Row = { userId: string; options: unknown; version: number; updatedAt: Date };

describe("CreationPreferencesService (VE2E-124)", () => {
  let rows: Row[];
  let service: CreationPreferencesService;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    rows = [];
    const userCreationPreference = {
      findUnique: async ({ where }: any) => rows.find((r) => r.userId === where.userId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = rows.find((r) => r.userId === where.userId);
        if (existing) {
          existing.options = update.options;
          existing.version += update.version.increment;
          existing.updatedAt = new Date();
          return existing;
        }
        const row = { version: 1, updatedAt: new Date(), ...create };
        rows.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const before = rows.length;
        rows = rows.filter((r) => r.userId !== where.userId);
        return { count: before - rows.length };
      },
    };
    const grants = { forUser: async (userId: string) => ({ teamIds: [], projectIds: [], channelIds: userId === "staff-1" ? ["ch-mine"] : [] }) };
    service = new CreationPreferencesService({ userCreationPreference } as never, grants as never);
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves JA + 65-90s + voice X + template Y as the user's defaults and reads them back", async () => {
    const saved = await service.save("staff-1", "staff", { options: { language: "ja", durationTarget: "65-90s", voiceId: "voice-x", templateId: "tpl-y" } });
    expect(saved).toMatchObject({ ok: true, data: { version: 1, options: { language: "ja", durationTarget: "65-90s", voiceId: "voice-x", templateId: "tpl-y" } } });
    await expect(service.get("staff-1")).resolves.toMatchObject({ ok: true, data: { options: { language: "ja" } } });
    await service.save("staff-1", "staff", { options: { language: "ko" } });
    await expect(service.get("staff-1")).resolves.toMatchObject({ ok: true, data: { version: 2, options: { language: "ko" } } });
  });

  it("never stores job content (topic, prompt, scripts, URL) as a default, even when sent", async () => {
    await service.save("staff-1", "staff", { options: { topic: "old topic", promptSpec: "p", existingScript: "s", autoRawScript: "r", autoArticleUrl: "https://x.y", language: "ja" } });
    expect(rows[0]!.options).toEqual({ language: "ja" });
  });

  it("is per user: another user's defaults are never visible, and a reset only resets your own", async () => {
    await service.save("staff-1", "staff", { options: { language: "ja" } });
    await expect(service.get("staff-2")).resolves.toEqual({ ok: true, data: null });
    await service.reset("staff-2");
    expect(rows).toHaveLength(1);
    await service.reset("staff-1");
    await expect(service.get("staff-1")).resolves.toEqual({ ok: true, data: null });
  });

  it("refuses a default channel the user has no access to; admin may save any channel", async () => {
    await expect(service.save("staff-2", "staff", { options: { channelId: "ch-mine" } })).resolves.toMatchObject({ ok: false, code: "FORBIDDEN", status: 403 });
    await expect(service.save("staff-1", "staff", { options: { channelId: "ch-mine" } })).resolves.toMatchObject({ ok: true });
    await expect(service.save("admin-1", "admin", { options: { channelId: "any" } })).resolves.toMatchObject({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
