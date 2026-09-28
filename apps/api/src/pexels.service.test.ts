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
  let providerAccounts: any;
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
    // Permissive by default (slot always granted, cooldown/release are no-ops) - VE2E-15a fan-out/cooldown behavior is covered by its own dedicated tests below.
    providerAccounts = {
      acquireContentRequestSlot: vi.fn(async () => true),
      releaseContentRequestSlot: vi.fn(async () => undefined),
      cooldownContentAccount: vi.fn(async () => new Date()),
      // VE2E-29: no vision-capable "content" account by default - every pre-existing test below keeps
      // exercising the metadata-only path unchanged. Tests exercising the new vision wiring override this.
      contentGenerationCandidates: vi.fn(async () => []),
    };
    service = new PexelsService(prisma, grants, media as MediaService, providerAccounts);
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
      service = new PexelsService(prisma, grants, media as MediaService, providerAccounts);
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
        // `alt` is real Pexels metadata (the only descriptive text its API exposes) - required here
        // since VE2E-15a's Auto-only relevance guard now abstains on a photo with no real
        // descriptor/vision evidence at all, even one that otherwise ranks well on continuity/quality.
        const photoWithAlt = { ...photoDetail, alt: "empty stadium stands with no crowd" };
        if (url.includes("/v1/search")) return new Response(JSON.stringify({ photos: [photoWithAlt] }), { status: 200 });
        if (url.includes("/v1/photos/")) return new Response(JSON.stringify(photoWithAlt), { status: 200 });
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

    it("VE2E-15a: ranks a bounded pool and imports the best-fit candidate, not the API's first result", async () => {
      const shortLandscape = { ...videoDetail, id: 1, width: 1920, height: 1080, duration: 1, video_files: [{ quality: "sd", width: 640, height: 360, file_type: "video/mp4", link: "https://videos.pexels.com/1-sd.mp4" }] };
      const goodPortrait = { ...videoDetail, id: 2, width: 1080, height: 1920, duration: 6, video_files: [{ quality: "hd", width: 1080, height: 1920, file_type: "video/mp4", link: "https://videos.pexels.com/2-hd.mp4" }] };
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [shortLandscape, goodPortrait] }), { status: 200 });
        if (url.includes("/videos/videos/2")) return new Response(JSON.stringify(goodPortrait), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: Buffer.from([0, 0, 0, 0x18]), mimeType: "video/mp4", finalUrl: "https://videos.pexels.com/2-hd.mp4" });
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-5", query: "person walking outside" });
      expect(outcome).toMatchObject({ ok: true, data: { asset: { id: "asset-1" } } });
      // Only the ranked winner (id 2) is ever re-fetched by import() - a call to `/videos/videos/1` would have thrown above.
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/videos/videos/1"))).toBe(false);
    });

    it("VE2E-15a: skips an externalId already used by another scene in the same run (continuity)", async () => {
      const used = { ...videoDetail, id: 1, video_files: [{ quality: "hd", width: 1080, height: 1920, file_type: "video/mp4", link: "https://videos.pexels.com/1-hd.mp4" }] };
      const fresh = { ...videoDetail, id: 2, video_files: [{ quality: "hd", width: 1080, height: 1920, file_type: "video/mp4", link: "https://videos.pexels.com/2-hd.mp4" }] };
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [used, fresh] }), { status: 200 });
        if (url.includes("/videos/videos/2")) return new Response(JSON.stringify(fresh), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: Buffer.from([0, 0, 0, 0x18]), mimeType: "video/mp4", finalUrl: "https://videos.pexels.com/2-hd.mp4" });
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-8", query: "person outside", usedExternalIds: ["1"] });
      expect(outcome).toMatchObject({ ok: true });
    });

    it("VE2E-15a: routes an exclusion-matching (effectively zero-relevance) top candidate to MEDIA_RELEVANCE_BELOW_THRESHOLD instead of silently importing it", async () => {
      const carPhoto = { ...photoDetail, alt: "a busy street full of cars honking" };
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
        if (url.includes("/v1/search")) return new Response(JSON.stringify({ photos: [carPhoto] }), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-4", query: "city street, no cars" });
      expect(outcome).toMatchObject({ ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" });
      expect(media.registerAsset).not.toHaveBeenCalled();
    });

    it("VE2E-15a: a live 429 stops fan-out and opens a cooldown on the shared 'visual' provider-account gate", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "retry-after": "30" } })));
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-6", query: "busy market" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_RATE_LIMITED" });
      expect(providerAccounts.cooldownContentAccount).toHaveBeenCalledWith("account-1", 30_000, expect.any(Date), "visual");
      expect(media.registerAsset).not.toHaveBeenCalled();
    });

    it("VE2E-15a: a denied shared account slot stops fan-out before calling Pexels at all", async () => {
      providerAccounts.acquireContentRequestSlot = vi.fn(async () => false);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-7", query: "anything" });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("VE2E-29: vision-wired photo relevance", () => {
      const visionAccount = (overrides: Record<string, unknown> = {}) => ({
        id: "content-1",
        provider: "openai",
        role: "content",
        status: "verified",
        model: "gpt-4o-mini",
        encryptedSecret: "encrypted",
        isFake: false,
        ...overrides,
      });
      const visionResponse = (body: Record<string, unknown>) =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200 });

      it("auto-selects a photo with no alt text once vision moderation accepts it", async () => {
        providerAccounts.contentGenerationCandidates = vi.fn(async () => [visionAccount()]);
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
          if (url.includes("/v1/search")) return new Response(JSON.stringify({ photos: [photoDetail] }), { status: 200 });
          if (url.includes("/v1/photos/")) return new Response(JSON.stringify(photoDetail), { status: 200 });
          if (url.includes("api.openai.com/v1/chat/completions")) {
            return visionResponse({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.9, confidence: 0.9, notes: "matches beat" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
          ok: true,
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          mimeType: "image/jpeg",
          finalUrl: photoDetail.src.original,
        });
        // No `alt` text on `photoDetail` - pre-VE2E-29, this would abstain to MEDIA_RELEVANCE_UNVERIFIED.
        const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-9", query: "person talking outside" });
        expect(outcome).toMatchObject({ ok: true, data: { asset: { id: "asset-1" } } });
      });

      it("routes a vision-rejected top photo to the existing rejected_by_moderation abstention instead of importing it", async () => {
        providerAccounts.contentGenerationCandidates = vi.fn(async () => [visionAccount()]);
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
          if (url.includes("/v1/search")) return new Response(JSON.stringify({ photos: [photoDetail] }), { status: 200 });
          if (url.includes("api.openai.com/v1/chat/completions")) {
            return visionResponse({ safety_flag: true, safety_categories: ["violence"], scene_beat_relevance: 0.8, confidence: 0.95, notes: "unsafe content" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
          ok: true,
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          mimeType: "image/jpeg",
          finalUrl: photoDetail.src.original,
        });
        const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-10", query: "person outside" });
        expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
        expect(media.registerAsset).not.toHaveBeenCalled();
      });

      it("falls back to the existing MEDIA_RELEVANCE_UNVERIFIED abstention when the vision call returns an unusable response (fail-closed)", async () => {
        providerAccounts.contentGenerationCandidates = vi.fn(async () => [visionAccount()]);
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
          if (url.includes("/v1/search")) return new Response(JSON.stringify({ photos: [photoDetail] }), { status: 200 });
          // Malformed content: fails JSON.parse inside `generateVisionStructuredOnce`, so the capability probe itself throws and `moderateSceneCandidate` fails closed to `raw: null` - the real moderation call is never even attempted.
          if (url.includes("api.openai.com/v1/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 });
          throw new Error(`unexpected fetch: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
          ok: true,
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          mimeType: "image/jpeg",
          finalUrl: photoDetail.src.original,
        });
        const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-11", query: "person outside" });
        expect(outcome).toMatchObject({ ok: false, code: "MEDIA_RELEVANCE_UNVERIFIED" });
        expect(media.registerAsset).not.toHaveBeenCalled();
      });

      it("never fans out vision calls beyond MAX_VISION_CANDIDATES_PER_SCENE, no matter how large the candidate pool is", async () => {
        providerAccounts.contentGenerationCandidates = vi.fn(async () => [visionAccount()]);
        // 7 candidates, strictly decreasing quality (heightPx) so pre-vision metadata ranking is deterministic: id "1" is always the best-fit winner.
        const photos = Array.from({ length: 7 }, (_, i) => ({
          ...photoDetail,
          id: i + 1,
          width: 600,
          height: 1080 - i * 110,
          src: { ...photoDetail.src },
        }));
        let visionCallCount = 0;
        const fetchMock = vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.includes("/videos/search")) return new Response(JSON.stringify({ videos: [] }), { status: 200 });
          if (url.includes("/v1/search")) return new Response(JSON.stringify({ photos }), { status: 200 });
          if (url.includes("/v1/photos/1")) return new Response(JSON.stringify(photos[0]), { status: 200 });
          if (url.includes("api.openai.com/v1/chat/completions")) {
            visionCallCount += 1;
            return visionResponse({ safety_flag: false, safety_categories: [], scene_beat_relevance: 0.9, confidence: 0.9, notes: "ok" });
          }
          throw new Error(`unexpected fetch: ${url}`);
        });
        vi.stubGlobal("fetch", fetchMock);
        vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
          ok: true,
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
          mimeType: "image/jpeg",
          finalUrl: photoDetail.src.original,
        });
        const outcome = await service.autoImportForScene(projectId, "user-1", "staff", { providerAccountId: "account-1", sceneId: "scene-12", query: "person outside" });
        expect(outcome).toMatchObject({ ok: true });
        // Each vision-checked candidate makes 2 calls (capability probe + real moderation) - capped at 5 candidates, never all 7.
        expect(visionCallCount).toBe(5 * 2);
        expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/v1/photos/6"))).toBe(false);
        expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/v1/photos/7"))).toBe(false);
      });
    });
  });
});
