import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetVersionSummary } from "@lyonix/contracts";
import { PexelsService } from "./pexels.service.js";
import { MediaService } from "./media.service.js";
import * as secretCrypto from "./secret-crypto.js";
import * as safeBinaryFetch from "./safe-binary-fetch.js";

const projectId = "project-1";
const fakeAsset = { id: "asset-1", projectId, origin: "pexels" } as unknown as MediaAssetVersionSummary;

const accountRow = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1",
  provider: "pexels",
  role: "visual",
  status: "verified",
  encryptedSecret: "encrypted",
  isFake: false,
  deletedAt: null,
  ...overrides,
});

const photoDetail = {
  id: 42,
  width: 1080,
  height: 1920,
  url: "https://www.pexels.com/photo/42/",
  photographer: "Jane Doe",
  photographer_url: "https://www.pexels.com/@jane-doe",
  src: { small: "https://images.pexels.com/photos/42/small.jpg", large: "https://images.pexels.com/photos/42/large.jpg", original: "https://images.pexels.com/photos/42/original.jpg" },
};

describe("PexelsService", () => {
  let mediaRootDir: string;
  let previousMediaRoot: string | undefined;
  let prisma: any;
  let grants: any;
  let media: Partial<MediaService>;
  let service: PexelsService;

  beforeEach(async () => {
    mediaRootDir = await mkdtemp(join(tmpdir(), "lyonix-pexels-"));
    previousMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = mediaRootDir;
    prisma = {
      project: { findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null) },
      providerAccount: { findFirst: async () => accountRow() },
    };
    grants = { forUser: async () => ({ projectIds: [projectId] }) };
    media = { registerAsset: vi.fn(async () => fakeAsset) };
    service = new PexelsService(prisma, grants, media as MediaService);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("px-test");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = previousMediaRoot;
    await rm(mediaRootDir, { recursive: true, force: true });
  });

  describe("search", () => {
    it("returns attribution for photo search without downloading anything", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ photos: [photoDetail] }), { status: 200 })));
      const outcome = await service.search(projectId, "user-1", "staff", { providerAccountId: "account-1", type: "photo", query: "sunset" });
      expect(outcome).toMatchObject({
        ok: true,
        data: { type: "photo", photos: [{ externalId: "42", attribution: { photographerName: "Jane Doe" } }] },
      });
      expect(media.registerAsset).not.toHaveBeenCalled();
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED when the account does not exist (no fake fallback)", async () => {
      prisma.providerAccount.findFirst = async () => null;
      const outcome = await service.search(projectId, "user-1", "staff", { providerAccountId: "missing", type: "photo", query: "sunset" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED when the account is unverified", async () => {
      prisma.providerAccount.findFirst = async () => accountRow({ status: "unverified" });
      const outcome = await service.search(projectId, "user-1", "staff", { providerAccountId: "account-1", type: "photo", query: "sunset" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    });

    it("hides an inaccessible project as not-found", async () => {
      grants = { forUser: async () => ({ projectIds: [] }) };
      service = new PexelsService(prisma, grants, media as MediaService);
      const outcome = await service.search(projectId, "user-1", "staff", { providerAccountId: "account-1", type: "photo", query: "sunset" });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });

  describe("import", () => {
    it("re-fetches the photo by id, downloads it safely, and registers a project asset with attribution", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(photoDetail), { status: 200 })));
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
        ok: true,
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        mimeType: "image/jpeg",
        finalUrl: photoDetail.src.original,
      });
      const outcome = await service.import(projectId, "user-1", "staff", { providerAccountId: "account-1", type: "photo", externalId: "42" });
      expect(outcome).toMatchObject({ ok: true, data: { asset: { id: "asset-1" } } });
      expect(media.registerAsset).toHaveBeenCalledWith(projectId, "user-1", "staff", expect.objectContaining({
        origin: "pexels",
        kind: "image",
        attribution: { photographerName: "Jane Doe", photographerUrl: "https://www.pexels.com/@jane-doe", pexelsPageUrl: "https://www.pexels.com/photo/42/" },
      }));
      expect(safeBinaryFetch.fetchBinarySafely).toHaveBeenCalledWith(photoDetail.src.original, expect.objectContaining({ allowedHostSuffix: ".pexels.com" }));
    });

    it("rejects a downloadUrl that fails the SSRF/domain-allowlist guard, without importing anything", async () => {
      const evilDetail = { ...photoDetail, src: { ...photoDetail.src, original: "https://evil.example/original.jpg" } };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(evilDetail), { status: 200 })));
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: false, reason: "domain_not_allowed" });
      const outcome = await service.import(projectId, "user-1", "staff", { providerAccountId: "account-1", type: "photo", externalId: "42" });
      expect(outcome).toMatchObject({ ok: false, code: "SSRF_BLOCKED" });
      expect(media.registerAsset).not.toHaveBeenCalled();
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED when the account is not pexels/visual", async () => {
      prisma.providerAccount.findFirst = async () => accountRow({ provider: "openai", role: "content" });
      const outcome = await service.import(projectId, "user-1", "staff", { providerAccountId: "account-1", type: "photo", externalId: "42" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    });

    it("maps a 401 from Pexels to PROVIDER_AUTH_INVALID without importing anything", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })));
      const outcome = await service.import(projectId, "user-1", "staff", { providerAccountId: "account-1", type: "photo", externalId: "42" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
      expect(media.registerAsset).not.toHaveBeenCalled();
    });
  });

  describe("autoImportForScene", () => {
    const videoDetail = {
      id: 7,
      width: 1080,
      height: 1920,
      duration: 8,
      url: "https://www.pexels.com/video/7/",
      user: { name: "Jane Doe", url: "https://www.pexels.com/@jane-doe" },
      video_files: [{ quality: "hd", width: 1080, height: 1920, file_type: "video/mp4", link: "https://player.vimeo.com/pexels/7/hd.mp4" }],
    };

    it("prefers the first video result and tags the imported asset with the scene id", async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [videoDetail] }), { status: 200 });
        if (url.includes("/videos/videos/")) return new Response(JSON.stringify(videoDetail), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
        ok: true,
        buffer: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
        mimeType: "video/mp4",
        finalUrl: "https://player.vimeo.com/pexels/7/hd.mp4",
      });
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-1", query: "football stadium" });
      expect(outcome).toMatchObject({ ok: true, data: { asset: { id: "asset-1" } } });
      expect(media.registerAsset).toHaveBeenCalledWith(projectId, "user-1", "staff", expect.objectContaining({ origin: "pexels", kind: "video", sceneId: "scene-1", reusable: true }));
    });

    it("falls back to photo search when video search has no hits", async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
        if (url.includes("/v1/search")) return new Response(JSON.stringify({ photos: [photoDetail] }), { status: 200 });
        if (url.includes("/v1/photos/")) return new Response(JSON.stringify(photoDetail), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
        ok: true,
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        mimeType: "image/jpeg",
        finalUrl: photoDetail.src.original,
      });
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-2", query: "empty stands" });
      expect(outcome).toMatchObject({ ok: true, data: { asset: { id: "asset-1" } } });
      expect(media.registerAsset).toHaveBeenCalledWith(projectId, "user-1", "staff", expect.objectContaining({ kind: "image", sceneId: "scene-2" }));
    });

    it("fails with PROVIDER_CAPABILITY_UNAVAILABLE (no fabricated asset) when both searches are empty", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ videos: [], photos: [] }), { status: 200 })));
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-3", query: "nonexistent query xyz" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
      expect(media.registerAsset).not.toHaveBeenCalled();
    });
  });
});
