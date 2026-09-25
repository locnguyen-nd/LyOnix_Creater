import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelsService } from "./channels.service.js";
import { encryptSecret } from "./secret-crypto.js";
import type { TiktokTokenSet } from "./tiktok.js";

const previousKey = process.env.PERSISTENCE_ENCRYPTION_KEY;

const tokenSet = (overrides: Partial<TiktokTokenSet> = {}): TiktokTokenSet => ({
  accessToken: "access-token",
  refreshToken: null,
  openId: "open-1",
  scope: ["user.info.basic"],
  expiresAt: Date.now() + 60 * 60 * 1000,
  ...overrides,
});

const channelRow = (overrides: Record<string, unknown> = {}) => ({
  id: "channel-1",
  status: "connected",
  authType: "oauth2",
  grantedScopes: ["user.info.basic"],
  encryptedSecret: encryptSecret(JSON.stringify(tokenSet())),
  ...overrides,
});

describe("ChannelsService.syncAllConnected", () => {
  let prisma: any;
  let service: ChannelsService;

  beforeEach(() => {
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    prisma = {
      channelConnection: {
        findMany: vi.fn(async () => [channelRow()]),
        update: vi.fn(async () => ({})),
      },
      metricSnapshot: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    service = new ChannelsService(prisma, {} as any);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { user: { open_id: "open-1", display_name: "Creator" } } }), { status: 200 }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.PERSISTENCE_ENCRYPTION_KEY = previousKey;
  });

  it("only queries connected oauth2 channels", async () => {
    await service.syncAllConnected();
    expect(prisma.channelConnection.findMany).toHaveBeenCalledWith({ where: { status: "connected", authType: "oauth2" } });
  });

  it("syncs every connected channel and reports a summary", async () => {
    const result = await service.syncAllConnected();
    expect(result).toEqual({ total: 1, synced: 1, invalid: 0, failed: 0 });
    expect(prisma.metricSnapshot.createMany).toHaveBeenCalledTimes(1);
  });

  it("counts a channel with no stored secret as invalid without touching the network", async () => {
    prisma.channelConnection.findMany = vi.fn(async () => [channelRow({ encryptedSecret: null })]);
    const result = await service.syncAllConnected();
    expect(result).toEqual({ total: 1, synced: 0, invalid: 1, failed: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("counts an unrecognized TikTok profile response as invalid, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "access_token_invalid" } }), { status: 200 })));
    const result = await service.syncAllConnected();
    expect(result).toEqual({ total: 1, synced: 0, invalid: 1, failed: 0 });
  });

  it("keeps syncing remaining channels when one channel throws", async () => {
    prisma.channelConnection.findMany = vi.fn(async () => [channelRow({ id: "channel-1" }), channelRow({ id: "channel-2" })]);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("network down");
        return new Response(JSON.stringify({ data: { user: { open_id: "open-1", display_name: "Creator" } } }), { status: 200 });
      }),
    );
    const result = await service.syncAllConnected();
    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.synced + result.invalid + result.failed).toBe(2);
  });
});
