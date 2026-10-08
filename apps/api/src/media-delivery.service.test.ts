import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaDeliveryService } from "./media-delivery.service.js";

describe("MediaDeliveryService.issueToken", () => {
  let prisma: any;
  let grants: any;
  let service: MediaDeliveryService;
  const originalBase = process.env.PUBLIC_BASE_URL;

  beforeEach(() => {
    prisma = {
      mediaAssetVersion: { findFirst: vi.fn(async () => ({ id: "asset-1", projectId: "project-1", deletedAt: null })) },
      mediaDeliveryToken: { create: vi.fn(async () => ({})) },
    };
    grants = { forUser: vi.fn(async () => ({ teamIds: [], projectIds: ["project-1"], channelIds: [] })) };
    service = new MediaDeliveryService(prisma, grants);
  });

  afterEach(() => {
    if (originalBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalBase;
  });

  it("provider audience needs PUBLIC_BASE_URL and returns the absolute public URL", async () => {
    delete process.env.PUBLIC_BASE_URL;
    await expect(service.issueToken("asset-1", "user-1", "staff")).resolves.toBe("not_configured");
    expect(prisma.mediaDeliveryToken.create).not.toHaveBeenCalled();

    process.env.PUBLIC_BASE_URL = "https://tunnel.example/";
    const issued = await service.issueToken("asset-1", "user-1", "staff");
    if (typeof issued !== "object" || !issued) throw new Error("expected a token");
    expect(issued.path).toBe(`/api/v1/media-delivery/${issued.token}`);
    expect(issued.url).toBe(`https://tunnel.example/api/v1/media-delivery/${issued.token}`);
  });

  it("browser audience works without PUBLIC_BASE_URL and always returns the API-relative path", async () => {
    delete process.env.PUBLIC_BASE_URL;
    const issued = await service.issueToken("asset-1", "user-1", "staff", undefined, "browser");
    if (typeof issued !== "object" || !issued) throw new Error("expected a token");
    expect(issued.path).toBe(`/api/v1/media-delivery/${issued.token}`);
    expect(issued.url).toBe(issued.path);
    expect(prisma.mediaDeliveryToken.create).toHaveBeenCalledTimes(1);
    // only the hash is stored, never the raw token
    expect(JSON.stringify(prisma.mediaDeliveryToken.create.mock.calls[0][0])).not.toContain(issued.token);
  });

  it("browser audience still enforces project access and soft delete", async () => {
    grants.forUser.mockResolvedValueOnce({ teamIds: [], projectIds: ["other"], channelIds: [] });
    await expect(service.issueToken("asset-1", "user-1", "staff", undefined, "browser")).resolves.toBe("forbidden");
    prisma.mediaAssetVersion.findFirst.mockResolvedValueOnce(null);
    await expect(service.issueToken("missing", "user-1", "staff", undefined, "browser")).resolves.toBeNull();
    expect(prisma.mediaDeliveryToken.create).not.toHaveBeenCalled();
  });
});
