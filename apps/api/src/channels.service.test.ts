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
    service = new ChannelsService(prisma, {} as any, {} as any);
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

// VE2E-19: per-channel finished-video library. Deliberately does not re-query
// StudioProjectBridge/RenderJob itself - reuses JobsService.list()'s already-resolved
// pipelineStep/render (VE2E-18), per the CR's own stated dependency.
describe("ChannelsService.listVideos", () => {
  const userId = "user-1";
  const channelId = "channel-1";

  const job = (overrides: Record<string, unknown> = {}) => ({
    id: "job-1",
    channelId,
    topic: "Lionel Messi",
    script: { caption: "#messi #goat", hook: "Ai la GOAT?" },
    pipelineStep: "done",
    render: { id: "render-1", status: "completed", resultUrl: "https://cdn.creatomate.com/x.mp4", snapshotUrl: "https://cdn.creatomate.com/x.jpg", renderDurationMs: 42000 },
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  });

  const makeService = (jobs: unknown[], channelRowOverrides: Record<string, unknown> = {}) => {
    const prisma: any = { channelConnection: { findUnique: vi.fn(async () => ({ id: channelId, ...channelRowOverrides })) } };
    const grants: any = { forUser: vi.fn(async () => ({ teamIds: [], projectIds: [], channelIds: [channelId] })) };
    const jobsService: any = { list: vi.fn(async () => jobs) };
    return new ChannelsService(prisma, grants, jobsService);
  };

  it("returns null when the channel does not exist or is outside the caller's grants", async () => {
    const prisma: any = { channelConnection: { findUnique: vi.fn(async () => null) } };
    const service = new ChannelsService(prisma, { forUser: vi.fn(async () => ({ teamIds: [], projectIds: [], channelIds: [] })) } as any, {} as any);
    expect(await service.listVideos(channelId, userId, "staff")).toBeNull();
  });

  it("only returns jobs for this channel whose pipelineStep is actually done", async () => {
    const service = makeService([
      job(),
      job({ id: "job-2", channelId: "other-channel" }),
      job({ id: "job-3", pipelineStep: "render", render: { ...job().render, status: "rendering", resultUrl: null } }),
    ]);
    const rows = await service.listVideos(channelId, userId, "staff");
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ jobId: "job-1", renderJobId: "render-1", resultUrl: "https://cdn.creatomate.com/x.mp4", thumbnailUrl: "https://cdn.creatomate.com/x.jpg" });
  });

  it("falls back to null thumbnailUrl when Creatomate never reported a snapshot_url", async () => {
    const service = makeService([job({ render: { ...job().render, snapshotUrl: null } })]);
    const rows = await service.listVideos(channelId, userId, "staff");
    expect(rows?.[0]?.thumbnailUrl).toBeNull();
  });

  it("uses the approved caption, falling back to hook then topic", async () => {
    const service = makeService([job({ script: { caption: "", hook: "hook text" } })]);
    expect((await service.listVideos(channelId, userId, "staff"))?.[0]?.caption).toBe("hook text");
  });

  it("sorts newest-completed first", async () => {
    const service = makeService([
      job({ id: "older", updatedAt: "2026-09-24T00:00:00.000Z" }),
      job({ id: "newer", updatedAt: "2026-09-26T00:00:00.000Z" }),
    ]);
    const rows = await service.listVideos(channelId, userId, "staff");
    expect(rows?.map((row) => row.jobId)).toEqual(["newer", "older"]);
  });
});
