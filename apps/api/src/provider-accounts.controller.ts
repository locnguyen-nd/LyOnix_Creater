import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { CURATED_CONTENT_MODELS, CURATED_ELEVENLABS_MODELS } from "@lyonix/providers";
import { ProviderAccountsService, type ProviderRole, type ProviderScope } from "./provider-accounts.service.js";

type CreateBody = { name?: string; provider?: string; role?: ProviderRole; scope?: ProviderScope; model?: string; secret?: string };
type UpdateBody = { name?: string; model?: string; secret?: string };

const expectedVersion = (raw: string | undefined) => {
  const match = raw?.trim().match(/^(?:W\/)?"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
};

@Controller()
export class ProviderAccountsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(ProviderAccountsService) private readonly accounts: ProviderAccountsService) {}

  @Get("provider-catalog")
  catalog(@Res({ passthrough: true }) response: Response) {
    return success([
      { provider: "openai", role: "content", implementationStatus: "available", models: CURATED_CONTENT_MODELS.openai },
      { provider: "gemini", role: "content", implementationStatus: "available", models: CURATED_CONTENT_MODELS.gemini },
      { provider: "xai", role: "content", implementationStatus: "available", models: CURATED_CONTENT_MODELS.xai },
      { provider: "elevenlabs", role: "tts", implementationStatus: "available", models: [...CURATED_ELEVENLABS_MODELS] },
      { provider: "pexels", role: "visual", implementationStatus: "available", models: [] },
      { provider: "creatomate", role: "render", implementationStatus: "available", models: [] },
      { provider: "vrew", role: "render", implementationStatus: "blocked", models: [] },
    ], requestId(response));
  }

  @Get("provider-accounts")
  async list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(await this.accounts.list(user.id, user.role), requestId(response));
  }

  @Post("provider-accounts")
  async create(@Body() body: CreateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.name?.trim() || !body.provider || !body.model?.trim() || !body.secret?.trim() || !["content", "tts", "visual", "render"].includes(body.role ?? "") || !["personal", "organization"].includes(body.scope ?? "")) {
      throw normalizedError("VALIDATION_FAILED", "Dữ liệu tài khoản provider không hợp lệ", requestId(response));
    }
    try {
      const account = await this.accounts.create({ name: body.name.trim(), provider: body.provider, role: body.role!, scope: body.scope!, model: body.model.trim(), secret: body.secret }, user.id, user.role);
      if (account === "unsupported") throw normalizedError("VALIDATION_FAILED", "Chỉ hỗ trợ OpenAI, Gemini, xAI (content), ElevenLabs (tts), Pexels (visual) hoặc Creatomate (render)", requestId(response));
      if (!account) throw normalizedError("FORBIDDEN", "Không có quyền tạo tài khoản tổ chức", requestId(response), 403);
      return success(account, requestId(response));
    } catch (error) {
      if (error instanceof Error && error.message.includes("PERSISTENCE_ENCRYPTION_KEY")) {
        throw normalizedError("PROVIDER_UNAVAILABLE", "Chưa cấu hình khóa mã hóa secret trên server", requestId(response), 503);
      }
      throw error;
    }
  }

  @Post("provider-accounts/:id/verify")
  @HttpCode(200)
  async verify(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.accounts.verify(id, user.id, user.role);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy tài khoản provider", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("FORBIDDEN", "Không có quyền sửa tài khoản provider này", requestId(response), 403);
    const account = "account" in result ? result.account : result;
    if ("code" in result) throw normalizedError("PROVIDER_UNAVAILABLE", "Khóa provider không hợp lệ hoặc nhà cung cấp từ chối", requestId(response), 502);
    return success(account, requestId(response));
  }

  @Patch("provider-accounts/:id")
  async update(@Param("id") id: string, @Headers("if-match") ifMatch: string | undefined, @Body() body: UpdateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const version = expectedVersion(ifMatch);
    if (version === null) throw normalizedError("VALIDATION_FAILED", "Thiếu If-Match phiên bản tài khoản", requestId(response));
    if (body.name === undefined && body.model === undefined && body.secret === undefined) throw normalizedError("VALIDATION_FAILED", "Không có thay đổi tài khoản", requestId(response));
    const account = await this.accounts.update(id, user.id, user.role, version, body);
    if (!account) throw normalizedError("NOT_FOUND", "Không tìm thấy tài khoản provider", requestId(response), 404);
    if (account === "forbidden") throw normalizedError("FORBIDDEN", "Không có quyền sửa tài khoản provider này", requestId(response), 403);
    if (account === "conflict") throw normalizedError("VERSION_CONFLICT", "Tài khoản đã được cập nhật ở nơi khác. Hãy tải lại.", requestId(response), 409);
    if (account === "invalid") throw normalizedError("VALIDATION_FAILED", "Tên và model không được để trống", requestId(response));
    if (account === "model_unavailable") throw normalizedError("PROVIDER_CAPABILITY_UNAVAILABLE", "Model không nằm trong capability đã xác thực", requestId(response));
    response.setHeader("ETag", `"${account.version}"`);
    return success(account, requestId(response));
  }

  @Delete("provider-accounts/:id")
  @HttpCode(200)
  async remove(@Param("id") id: string, @Headers("if-match") ifMatch: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const version = expectedVersion(ifMatch);
    if (version === null) throw normalizedError("VALIDATION_FAILED", "Thiếu If-Match phiên bản tài khoản", requestId(response));
    const result = await this.accounts.remove(id, user.id, user.role, version);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy tài khoản provider", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("FORBIDDEN", "Không có quyền xóa tài khoản provider này", requestId(response), 403);
    if (result === "conflict") throw normalizedError("VERSION_CONFLICT", "Tài khoản đã được cập nhật ở nơi khác. Hãy tải lại.", requestId(response), 409);
    return success({ id, deleted: true }, requestId(response));
  }
}
