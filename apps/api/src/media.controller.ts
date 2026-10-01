import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { MediaAssetKind, MediaOrigin } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { MediaService } from "./media.service.js";
import { uploadMaxBytes } from "./quarantine.js";

type CreateFolderBody = { name?: string; parentId?: string | null };
type ImportUrlBody = { url?: string; folderId?: string | null; reusable?: boolean; kind?: MediaAssetKind };
type AssignSceneBody = { sceneId?: string | null };
type RegisterAssetBody = {
  quarantineToken?: string;
  kind?: MediaAssetKind;
  originalFileName?: string;
  mimeType?: string;
  checksumSha256?: string;
  bytes?: number;
  widthPx?: number | null;
  heightPx?: number | null;
  durationMs?: number | null;
  origin?: MediaOrigin;
  license?: string | null;
  reusable?: boolean;
  folderId?: string | null;
};

@Controller()
export class MediaController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(MediaService) private readonly media: MediaService) {}

  @Get("projects/:projectId/media-folders")
  async listFolders(@Param("projectId") projectId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const result = await this.media.listFolders(projectId, user.id, user.role);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    return success(result, requestId(response));
  }

  @Post("projects/:projectId/media-folders")
  async createFolder(@Param("projectId") projectId: string, @Body() body: CreateFolderBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.media.createFolder(projectId, user.id, user.role, { name: body.name ?? "", parentId: body.parentId ?? null });
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    if (result === "invalid") throw normalizedError("VALIDATION_FAILED", "Tên thư mục không hợp lệ", requestId(response));
    return success(result, requestId(response));
  }

  @Get("projects/:projectId/media-assets")
  async listAssets(@Param("projectId") projectId: string, @Query("folderId") folderId: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const result = await this.media.listAssets(projectId, user.id, user.role, folderId);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    return success(result, requestId(response));
  }

  @Post("projects/:projectId/media-assets")
  async registerAsset(@Param("projectId") projectId: string, @Body() body: RegisterAssetBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.quarantineToken || !body.kind || !body.originalFileName?.trim() || !body.mimeType?.trim() || !body.checksumSha256 || !body.bytes || !body.origin) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu dữ liệu asset", requestId(response));
    }
    // VE2E-34: `apify` provenance is written only by the server-side Apify import path; a client can never claim it.
    if (body.origin === "apify") {
      throw normalizedError("VALIDATION_FAILED", "origin apify chỉ do server đặt (import Apify)", requestId(response), 400);
    }
    const result = await this.media.registerAsset(projectId, user.id, user.role, {
      quarantineToken: body.quarantineToken,
      kind: body.kind,
      originalFileName: body.originalFileName,
      mimeType: body.mimeType,
      checksumSha256: body.checksumSha256,
      bytes: body.bytes,
      widthPx: body.widthPx ?? null,
      heightPx: body.heightPx ?? null,
      durationMs: body.durationMs ?? null,
      origin: body.origin,
      license: body.license ?? null,
      reusable: body.reusable ?? true,
      folderId: body.folderId ?? null,
    });
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    if (result === "invalid") throw normalizedError("VALIDATION_FAILED", "Dữ liệu asset không hợp lệ", requestId(response));
    if (result === "unsupported_media") throw normalizedError("UNSUPPORTED_MEDIA", "MIME không khớp loại asset", requestId(response), 415);
    if (result === "quarantine_missing") throw normalizedError("VALIDATION_FAILED", "Không tìm thấy file trong quarantine hoặc token đã dùng", requestId(response), 409);
    return success(result, requestId(response));
  }

  /** Raw-body upload (`Content-Type: video/*|image/*`); name and browser-measured metadata travel in the query string. */
  @Post("projects/:projectId/media-assets/upload")
  async upload(
    @Param("projectId") projectId: string,
    @Query() query: { fileName?: string; widthPx?: string; heightPx?: string; durationMs?: string; folderId?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const fileName = (query.fileName ?? "").replace(/[\\/]/g, "_").slice(0, 160);
    if (!fileName.trim()) throw normalizedError("VALIDATION_FAILED", "Thiếu tên file", requestId(response));
    const positiveInt = (value: string | undefined) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
    const result = await this.media.uploadStream(projectId, user.id, user.role, {
      stream: request,
      fileName,
      maxBytes: uploadMaxBytes(),
      widthPx: positiveInt(query.widthPx),
      heightPx: positiveInt(query.heightPx),
      durationMs: positiveInt(query.durationMs),
      folderId: query.folderId || null,
    });
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    if (result === "too_large") throw normalizedError("VALIDATION_FAILED", "File vượt giới hạn dung lượng upload", requestId(response), 413);
    if (result === "unsupported_media") throw normalizedError("UNSUPPORTED_MEDIA", "File không phải video/ảnh được hỗ trợ (MP4, MOV, WebM, JPG, PNG, WebP, GIF)", requestId(response), 415);
    if (result === "invalid" || result === "quarantine_missing") throw normalizedError("VALIDATION_FAILED", "Không thể lưu file đã upload", requestId(response), 409);
    return success(result, requestId(response));
  }

  @Post("projects/:projectId/media-assets/import-url")
  async importFromUrl(@Param("projectId") projectId: string, @Body() body: ImportUrlBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.url?.trim()) throw normalizedError("VALIDATION_FAILED", "Thiếu url để import", requestId(response));
    const result = await this.media.importFromUrl(projectId, user.id, user.role, {
      url: body.url,
      folderId: body.folderId ?? null,
      reusable: body.reusable ?? true,
      ...(body.kind ? { kind: body.kind } : {}),
    });
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    if (result === "invalid") throw normalizedError("VALIDATION_FAILED", "Nội dung tải về không hợp lệ hoặc rỗng", requestId(response));
    if (result === "unsupported_media") throw normalizedError("UNSUPPORTED_MEDIA", "MIME không khớp loại asset", requestId(response), 415);
    if (result === "quarantine_missing") throw normalizedError("VALIDATION_FAILED", "Không thể lưu file đã tải về", requestId(response), 409);
    if (result === "ssrf_blocked") throw normalizedError("SSRF_BLOCKED", "URL bị chặn bởi SSRF guard", requestId(response), 400);
    if (result === "fetch_failed" || result === "mime_not_allowed" || result === "too_large" || result === "too_many_redirects" || result === "domain_not_allowed") {
      throw normalizedError("VALIDATION_FAILED", "Không thể tải file từ URL đã cho", requestId(response), 502);
    }
    return success(result, requestId(response));
  }

  @Post("media-assets/:id/scene")
  async assignScene(@Param("id") id: string, @Body() body: AssignSceneBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.media.assignScene(id, user.id, user.role, body.sceneId ?? null);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy asset", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("FORBIDDEN", "Không có quyền sửa asset này", requestId(response), 403);
    return success(result, requestId(response));
  }

  @Delete("media-assets/:id")
  async removeAsset(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.media.removeAsset(id, user.id, user.role);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy asset", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("FORBIDDEN", "Không có quyền xóa asset này", requestId(response), 403);
    return success({ deleted: true }, requestId(response));
  }
}
