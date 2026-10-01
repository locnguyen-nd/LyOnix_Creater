import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaService } from "./media.service.js";
import * as safeBinaryFetch from "./safe-binary-fetch.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const userId = "user-1";

describe("MediaService", () => {
  let mediaRootDir: string;
  let previousMediaRoot: string | undefined;
  let prisma: any;
  let assets: Map<string, any>;
  let service: MediaService;

  beforeEach(async () => {
    mediaRootDir = await mkdtemp(join(tmpdir(), "lyonix-media-service-"));
    previousMediaRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = mediaRootDir;
    assets = new Map();
    let counter = 0;
    prisma = {
      project: { findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null) },
      mediaFolder: { findFirst: async () => null },
      mediaAssetVersion: {
        findMany: async () => [...assets.values()],
        findFirst: async ({ where }: any) => assets.get(where.id) ?? null,
        findUnique: async ({ where }: any) => assets.get(where.id) ?? null,
        create: vi.fn(async ({ data }: any) => {
          counter += 1;
          const row = { id: `asset-${counter}`, version: 1, createdAt: new Date(), deletedAt: null, folderId: null, ...data };
          assets.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = { ...assets.get(where.id), ...data };
          assets.set(where.id, row);
          return row;
        }),
      },
    };
    const grants = { forUser: async () => ({ projectIds: [projectId] }) };
    service = new MediaService(prisma, grants as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = previousMediaRoot;
    await rm(mediaRootDir, { recursive: true, force: true });
  });

  describe("registerAsset", () => {
    it("merges Pexels attribution into provenance and surfaces it on the summary", async () => {
      const { writeQuarantineFile } = await import("./quarantine.js");
      const quarantined = await writeQuarantineFile(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const result = await service.registerAsset(projectId, userId, "staff", {
        quarantineToken: quarantined.quarantineToken,
        kind: "image",
        originalFileName: "pexels-42.jpg",
        mimeType: "image/jpeg",
        checksumSha256: quarantined.sha256,
        bytes: quarantined.bytes,
        origin: "pexels",
        reusable: true,
        attribution: { photographerName: "Jane Doe", photographerUrl: "https://www.pexels.com/@jane-doe", pexelsPageUrl: "https://www.pexels.com/photo/42/" },
      });
      expect(result).toMatchObject({
        attribution: { photographerName: "Jane Doe", photographerUrl: "https://www.pexels.com/@jane-doe", pexelsPageUrl: "https://www.pexels.com/photo/42/" },
        origin: "pexels",
        retentionClass: "project",
      });
    });

    it("stores an opaque sceneId when provided", async () => {
      const { writeQuarantineFile } = await import("./quarantine.js");
      const quarantined = await writeQuarantineFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const result: any = await service.registerAsset(projectId, userId, "staff", {
        quarantineToken: quarantined.quarantineToken,
        kind: "image",
        originalFileName: "a.jpg",
        mimeType: "image/png",
        checksumSha256: quarantined.sha256,
        bytes: quarantined.bytes,
        origin: "upload",
        reusable: true,
        sceneId: "scene-1",
      });
      expect(result.sceneId).toBe("scene-1");
    });
  });

  describe("listAssets lineage (VE2E-42)", () => {
    const baseRow = { projectId, folderId: null, kind: "video", originalFileName: "clip.mp4", mimeType: "video/mp4", checksumSha256: "a".repeat(64), bytes: 10, widthPx: null, heightPx: null, durationMs: 4000, origin: "pexels", license: null, reusable: false, retentionClass: "working", expiresAt: null, version: 1, createdAt: new Date(), deletedAt: null, provenance: {} };

    it("surfaces parent + parsed transform on a derivative, null on originals and on a malformed stored transform", async () => {
      assets.set("orig", { ...baseRow, id: "orig" });
      assets.set("deriv", { ...baseRow, id: "deriv", parentMediaAssetVersionId: "orig", transform: { range: { startMs: 1000, durationMs: 4000 }, stripAudio: true, tool: { name: "ffmpeg", version: "7" }, profileVersion: "clip.prepare@1" } });
      assets.set("broken", { ...baseRow, id: "broken", parentMediaAssetVersionId: "orig", transform: { stripAudio: "yes" } });
      const rows = await service.listAssets(projectId, userId, "staff");
      if (rows === "forbidden") throw new Error("expected rows");
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get("orig")).toMatchObject({ parentMediaAssetVersionId: null, transform: null });
      expect(byId.get("deriv")).toMatchObject({ parentMediaAssetVersionId: "orig", transform: { range: { startMs: 1000, durationMs: 4000 }, stripAudio: true, tool: { name: "ffmpeg", version: "7" }, profileVersion: "clip.prepare@1" } });
      expect(byId.get("broken")).toMatchObject({ parentMediaAssetVersionId: "orig", transform: null });
    });
  });

  describe("assignScene", () => {
    it("assigns and then clears the sceneId on an existing asset", async () => {
      const { writeQuarantineFile } = await import("./quarantine.js");
      const quarantined = await writeQuarantineFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const created: any = await service.registerAsset(projectId, userId, "staff", {
        quarantineToken: quarantined.quarantineToken,
        kind: "image",
        originalFileName: "a.jpg",
        mimeType: "image/png",
        checksumSha256: quarantined.sha256,
        bytes: quarantined.bytes,
        origin: "upload",
        reusable: true,
      });
      const assigned: any = await service.assignScene(created.id, userId, "staff", "scene-9");
      expect(assigned.sceneId).toBe("scene-9");
      const cleared: any = await service.assignScene(created.id, userId, "staff", null);
      expect(cleared.sceneId).toBeNull();
    });

    it("returns null for a missing asset and forbidden for an inaccessible project", async () => {
      expect(await service.assignScene("missing", userId, "staff", "s1")).toBeNull();
      assets.set("asset-x", { id: "asset-x", projectId: "other-project", deletedAt: null });
      const grants = { forUser: async () => ({ projectIds: [] }) };
      service = new MediaService(prisma, grants as any);
      expect(await service.assignScene("asset-x", userId, "staff", "s1")).toBe("forbidden");
    });
  });

  describe("importFromUrl", () => {
    it("downloads via the SSRF-safe fetcher, checksums, and registers the asset", async () => {
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
        ok: true,
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimeType: "image/png",
        finalUrl: "https://example.com/folder/pic.png",
      });
      const result: any = await service.importFromUrl(projectId, userId, "staff", { url: "https://example.com/folder/pic.png" });
      expect(result.origin).toBe("import_url");
      expect(result.originalFileName).toBe("pic.png");
      expect(result.mimeType).toBe("image/png");
      expect(result.kind).toBe("image");
    });

    it("propagates ssrf_blocked without registering anything", async () => {
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: false, reason: "ssrf_blocked" });
      const result = await service.importFromUrl(projectId, userId, "staff", { url: "http://169.254.169.254/x" });
      expect(result).toBe("ssrf_blocked");
      expect(prisma.mediaAssetVersion.create).not.toHaveBeenCalled();
    });

    it("rejects when the downloaded MIME does not match the requested kind", async () => {
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
        ok: true,
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimeType: "image/png",
        finalUrl: "https://example.com/a.png",
      });
      const result = await service.importFromUrl(projectId, userId, "staff", { url: "https://example.com/a.png", kind: "video" });
      expect(result).toBe("unsupported_media");
    });

    it("rejects forged image MIME when the quarantined bytes are not an image", async () => {
      vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({
        ok: true,
        buffer: Buffer.from("<script>alert(1)</script>"),
        mimeType: "image/png",
        finalUrl: "https://example.com/a.png",
      });
      const result = await service.importFromUrl(projectId, userId, "staff", { url: "https://example.com/a.png", kind: "image" });
      expect(result).toBe("unsupported_media");
      expect(prisma.mediaAssetVersion.create).not.toHaveBeenCalled();
    });
  });

  describe("uploadStream (long source video)", () => {
    const mp4 = (extra = 0) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40 + extra, 7)]);
    async function* chunks(buffer: Buffer, size = 16) { for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size); }

    it("streams the body to storage, sniffs the real type and registers an upload asset with the browser-measured duration", async () => {
      const body = mp4(200);
      const result = await service.uploadStream(projectId, userId, "staff", { stream: chunks(body), fileName: "long.mp4", maxBytes: 1_000_000, durationMs: 600_000, widthPx: 1920, heightPx: 1080 });
      expect(result).toMatchObject({ kind: "video", origin: "upload", mimeType: "video/mp4", bytes: body.length, durationMs: 600_000, originalFileName: "long.mp4" });
    });

    it("rejects files over the cap and leaves nothing registered", async () => {
      const result = await service.uploadStream(projectId, userId, "staff", { stream: chunks(mp4(500)), fileName: "huge.mp4", maxBytes: 100 });
      expect(result).toBe("too_large");
      expect(prisma.mediaAssetVersion.create).not.toHaveBeenCalled();
    });

    it("rejects non-media bytes regardless of the file name", async () => {
      const result = await service.uploadStream(projectId, userId, "staff", { stream: chunks(Buffer.from("<html>not a video</html>")), fileName: "fake.mp4", maxBytes: 1_000_000 });
      expect(result).toBe("unsupported_media");
      expect(prisma.mediaAssetVersion.create).not.toHaveBeenCalled();
    });
  });
});
