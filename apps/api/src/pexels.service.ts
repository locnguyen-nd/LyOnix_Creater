/**
 * VE2E-04: Pexels portrait photo/video search + import into the project media
 * library. Preview (search results) never downloads the full asset — only
 * thumbnail/preview URLs from Pexels' own CDN. Import always re-fetches the
 * authoritative photo/video detail by id from Pexels (never trusts a
 * client-supplied download URL), then downloads through the SSRF-safe,
 * domain-locked `fetchBinarySafely` before validating MIME/size/checksum and
 * handing off to `MediaService.registerAsset` (same quarantine/dedupe/
 * retention pipeline every other asset source uses).
 */
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ProviderError,
  getPexelsPhoto,
  getPexelsVideo,
  pickPexelsVideoFile,
  searchPexelsPhotos,
  searchPexelsVideos,
} from "@lyonix/providers";
import { canAccessProject } from "@lyonix/domain";
import type {
  ErrorCode,
  MediaAssetKind,
  PexelsImportResponse,
  PexelsMediaType,
  PexelsSearchResponse,
} from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { MediaService } from "./media.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { fetchBinarySafely } from "./safe-binary-fetch.js";
import { writeQuarantineFile } from "./quarantine.js";

export type PexelsOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

/** Generic sanity ceiling for a single Pexels photo/video download (well above typical portrait-short assets). */
const MAX_PEXELS_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const providerErrorMessage: Record<string, string> = {
  PROVIDER_AUTH_INVALID: "Khóa Pexels bị từ chối. Verify lại tài khoản.",
  PROVIDER_RATE_LIMITED: "Pexels giới hạn tốc độ, thử lại sau.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Pexels từ chối yêu cầu này (quyền/entitlement).",
  PROVIDER_TIMEOUT: "Yêu cầu Pexels hết thời gian chờ.",
  PROVIDER_SCHEMA_INVALID: "Pexels trả về dữ liệu không hợp lệ.",
};

const mapProviderError = (error: unknown): { code: ErrorCode; message: string; status: number; retryable: boolean } => {
  if (error instanceof ProviderError) {
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_AUTH_INVALID";
    return { code: error.code, message: providerErrorMessage[error.code] ?? "Pexels từ chối yêu cầu", status: switchable ? 429 : 502, retryable: error.retryable };
  }
  return { code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi Pexels", status: 502, retryable: true };
};

export type SearchInput = { providerAccountId: string; type: PexelsMediaType; query: string; page?: number; perPage?: number };
export type ImportInput = { providerAccountId: string; type: PexelsMediaType; externalId: string; folderId?: string | null; reusable?: boolean; sceneId?: string | null };

@Injectable()
export class PexelsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  private async assertProjectAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return false;
    const grants = await this.grants.forUser(userId, role);
    return canAccessProject(role, grants, projectId);
  }

  /** Any non-deleted `pexels`/`visual` account, verified (or fake in test) — same authorization shape as `ScriptGenerationService`/`ElevenLabsVoiceService`. */
  private async usableAccount(providerAccountId: string): Promise<PexelsOutcome<{ id: string; encryptedSecret: string }>> {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, deletedAt: null } });
    if (!account) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản provider không tồn tại hoặc đã bị xóa", status: 503 };
    if (account.role !== "visual" || account.provider !== "pexels") {
      return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Tài khoản không phải Pexels (visual)", status: 503 };
    }
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản Pexels chưa verify", status: 503 };
    return { ok: true, data: { id: account.id, encryptedSecret: account.encryptedSecret } };
  }

  async search(projectId: string, userId: string, role: "admin" | "staff", input: SearchInput): Promise<PexelsOutcome<PexelsSearchResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!input.query.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu từ khóa tìm kiếm" };
    const apiKey = decryptSecret(account.data.encryptedSecret);
    try {
      const searchOptions = { ...(input.page !== undefined ? { page: input.page } : {}), ...(input.perPage !== undefined ? { perPage: input.perPage } : {}) };
      if (input.type === "photo") {
        const photos = await searchPexelsPhotos(apiKey, input.query, searchOptions);
        return {
          ok: true,
          data: {
            type: "photo",
            query: input.query,
            page: input.page ?? 1,
            perPage: input.perPage ?? 15,
            photos: photos.map((p) => ({ externalId: p.externalId, width: p.width, height: p.height, attribution: p.attribution, thumbnailUrl: p.thumbnailUrl, previewUrl: p.previewUrl })),
            videos: [],
          },
        };
      }
      const videos = await searchPexelsVideos(apiKey, input.query, searchOptions);
      return {
        ok: true,
        data: {
          type: "video",
          query: input.query,
          page: input.page ?? 1,
          perPage: input.perPage ?? 15,
          photos: [],
          videos: videos.map((v) => ({
            externalId: v.externalId,
            width: v.width,
            height: v.height,
            durationSeconds: v.durationSeconds,
            attribution: v.attribution,
            thumbnailUrl: v.thumbnailUrl,
            fileOptions: v.fileOptions.map((f) => ({ quality: f.quality, width: f.width, height: f.height, fileType: f.fileType })),
          })),
        },
      };
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
  }

  async import(projectId: string, userId: string, role: "admin" | "staff", input: ImportInput): Promise<PexelsOutcome<PexelsImportResponse>> {
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!input.externalId.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu externalId để import" };
    const apiKey = decryptSecret(account.data.encryptedSecret);

    let downloadUrl: string;
    let kind: MediaAssetKind;
    let widthPx: number | null;
    let heightPx: number | null;
    let durationMs: number | null;
    let attribution: { photographerName: string; photographerUrl: string; pexelsPageUrl: string };
    let originalFileName: string;
    try {
      if (input.type === "photo") {
        const detail = await getPexelsPhoto(apiKey, input.externalId);
        if (!detail.downloadUrl) return { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: "Pexels không trả về link tải ảnh", status: 502 };
        downloadUrl = detail.downloadUrl;
        kind = "image";
        widthPx = detail.width || null;
        heightPx = detail.height || null;
        durationMs = null;
        attribution = detail.attribution;
        originalFileName = `pexels-${detail.externalId}.jpg`;
      } else {
        const detail = await getPexelsVideo(apiKey, input.externalId);
        const file = pickPexelsVideoFile(detail.fileOptions);
        if (!file) return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Pexels không có file mp4 phù hợp cho video này", status: 502 };
        downloadUrl = file.link;
        kind = "video";
        widthPx = file.width || null;
        heightPx = file.height || null;
        durationMs = Math.round(detail.durationSeconds * 1000) || null;
        attribution = detail.attribution;
        originalFileName = `pexels-${detail.externalId}.mp4`;
      }
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }

    const downloaded = await fetchBinarySafely(downloadUrl, { maxBytes: MAX_PEXELS_DOWNLOAD_BYTES, allowedHostSuffix: ".pexels.com" });
    if (!downloaded.ok) {
      if (downloaded.reason === "ssrf_blocked" || downloaded.reason === "domain_not_allowed") {
        return { ok: false, code: "SSRF_BLOCKED", message: "Link tải Pexels bị chặn bởi SSRF guard", status: 400 };
      }
      return { ok: false, code: "VALIDATION_FAILED", message: "Không tải được file từ Pexels", status: 502 };
    }
    if (downloaded.buffer.byteLength === 0) return { ok: false, code: "VALIDATION_FAILED", message: "File tải về từ Pexels rỗng", status: 502 };

    const checksumSha256 = createHash("sha256").update(downloaded.buffer).digest("hex");
    const quarantined = await writeQuarantineFile(downloaded.buffer);
    const registered = await this.media.registerAsset(projectId, userId, role, {
      quarantineToken: quarantined.quarantineToken,
      kind,
      originalFileName,
      mimeType: downloaded.mimeType || (kind === "image" ? "image/jpeg" : "video/mp4"),
      checksumSha256,
      bytes: downloaded.buffer.byteLength,
      widthPx,
      heightPx,
      durationMs,
      origin: "pexels",
      license: "Pexels License (https://www.pexels.com/license/)",
      reusable: input.reusable ?? true,
      folderId: input.folderId ?? null,
      sceneId: input.sceneId ?? null,
      attribution,
    });
    if (registered === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    if (registered === "invalid" || registered === "unsupported_media" || registered === "quarantine_missing") {
      return { ok: false, code: "VALIDATION_FAILED", message: "Không thể lưu asset Pexels vào project", status: 500 };
    }
    return { ok: true, data: { asset: registered } };
  }

  /**
   * VE2E-06 Auto media-preparing step: search Pexels for `query` and import the first
   * result, tagged with `sceneId`. Tries portrait video first (short-form default),
   * then falls back to photo when the video search has no hits — never fabricates a
   * placeholder asset when both come back empty. Only used by the trusted background
   * `WorkflowRunnerService`, not exposed as its own HTTP endpoint (callers needing
   * manual pick-from-results control should keep using `search()` + `import()`).
   */
  async autoImportForScene(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; sceneId: string; query: string; folderId?: string | null },
  ): Promise<PexelsOutcome<PexelsImportResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!input.query.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu từ khóa tìm kiếm cho scene" };
    const apiKey = decryptSecret(account.data.encryptedSecret);
    let firstVideoId: string | null = null;
    let firstPhotoId: string | null = null;
    try {
      const videos = await searchPexelsVideos(apiKey, input.query, { perPage: 1 });
      firstVideoId = videos[0]?.externalId ?? null;
      if (!firstVideoId) {
        const photos = await searchPexelsPhotos(apiKey, input.query, { perPage: 1 });
        firstPhotoId = photos[0]?.externalId ?? null;
      }
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
    if (!firstVideoId && !firstPhotoId) {
      return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: `Pexels không có kết quả nào cho scene (query: "${input.query}")`, status: 502 };
    }
    return this.import(projectId, userId, role, {
      providerAccountId: input.providerAccountId,
      type: firstVideoId ? "video" : "photo",
      externalId: (firstVideoId ?? firstPhotoId)!,
      sceneId: input.sceneId,
      reusable: true,
      ...(input.folderId ? { folderId: input.folderId } : {}),
    });
  }
}
