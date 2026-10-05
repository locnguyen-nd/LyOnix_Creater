import { Body, Controller, Delete, Get, HttpStatus, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ErrorCode } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { JobsService } from "./jobs.service.js";
import type { ScriptDraft } from "./script-draft.js";

type CreateBody = {
  topic?: string;
  locale?: string;
  mode?: "topic" | "long_video";
  channelId?: string;
  promptSpec?: string;
  contentProviderAccountId?: string;
  existingScript?: string;
};

@Controller()
export class JobsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(JobsService) private readonly jobs: JobsService) {}

  @Get("jobs")
  async list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(await this.jobs.list(user.id, user.role), requestId(response));
  }

  @Get("jobs/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const job = await this.jobs.getForDisplay(id, user.id, user.role);
    if (!job) throw normalizedError("NOT_FOUND", "Không tìm thấy việc", requestId(response), 404);
    return success(job, requestId(response));
  }

  @Post("jobs")
  async create(@Body() body: CreateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const job = await this.jobs.create({
      userId: user.id,
      topic: body.topic ?? "",
      locale: body.locale ?? "vi",
      mode: body.mode === "long_video" ? "long_video" : "topic",
      channelId: body.channelId ?? "",
      promptSpec: body.promptSpec ?? "",
      contentProviderAccountId: body.contentProviderAccountId ?? "",
      existingScript: body.existingScript ?? "",
    });
    if (job === "invalid") throw normalizedError("VALIDATION_FAILED", "Thiếu chủ đề kịch bản", requestId(response));
    if (job === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy kênh", requestId(response), 404);
    if (job === "provider") throw normalizedError("VALIDATION_FAILED", "Chọn tài khoản content OpenAI, Gemini hoặc xAI đã kết nối", requestId(response));
    return success(job, requestId(response));
  }

  @Post("jobs/:id/script")
  async save(@Param("id") id: string, @Body() body: { script?: ScriptDraft }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.script) throw normalizedError("VALIDATION_FAILED", "Thiếu kịch bản", requestId(response));
    const job = await this.jobs.saveScript(id, user.id, user.role, body.script);
    if (!job) throw normalizedError("NOT_FOUND", "Không tìm thấy việc", requestId(response), 404);
    return success(job, requestId(response));
  }

  @Post("jobs/:id/script/generate")
  async generate(@Param("id") id: string, @Body() body: { direction?: string }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const job = await this.jobs.generate(id, user.id, user.role, body.direction?.trim() || "");
    if (!job) throw normalizedError("NOT_FOUND", "Không tìm thấy việc", requestId(response), 404);
    if (job === "provider") throw normalizedError("PROVIDER_UNAVAILABLE", "Tài khoản content không dùng được", requestId(response), 502);
    if (job === "schema") throw normalizedError("PROVIDER_SCHEMA_INVALID", "Model không trả kịch bản đúng ScriptDraftV1. Xem nhật ký trên việc.", requestId(response), 502);
    if (typeof job === "string") {
      const code = (job.startsWith("PROVIDER_") ? job : "PROVIDER_UNAVAILABLE") as ErrorCode;
      const switchHint = " Đổi tài khoản content khác trên trang kịch bản rồi Generate lại.";
      const messages: Partial<Record<ErrorCode, string>> = {
        PROVIDER_AUTH_INVALID: `Khóa API bị từ chối khi generate. Verify lại hoặc đổi tài khoản.${switchHint}`,
        PROVIDER_SCHEMA_INVALID: "Model từ chối schema hoặc không trả JSON hợp lệ.",
        PROVIDER_RATE_LIMITED: `Provider hết hạn mức hoặc giới hạn tốc độ.${switchHint}`,
        PROVIDER_QUOTA_EXHAUSTED: `Tài khoản content hết credit/quota.${switchHint}`,
        PROVIDER_TIMEOUT: "Generate hết thời gian chờ (120s).",
        PROVIDER_UNAVAILABLE: "Không gọi được model. Kiểm tra mạng/API log server.",
        PROVIDER_CAPABILITY_UNAVAILABLE: "Model này nhà cung cấp đã tắt hoặc không còn cho tài khoản mới. Đổi model trên Settings (Gemini: gemini-3.1-pro-preview) rồi Generate lại. Verify khóa không chứng minh model generate còn bán.",
      };
      const switchable = code === "PROVIDER_RATE_LIMITED" || code === "PROVIDER_QUOTA_EXHAUSTED" || code === "PROVIDER_AUTH_INVALID";
      throw normalizedError(code, messages[code] ?? "Nhà cung cấp từ chối generate", requestId(response), switchable ? HttpStatus.TOO_MANY_REQUESTS : 502);
    }
    return success(job, requestId(response));
  }

  @Post("jobs/:id/content-account")
  async switchAccount(
    @Param("id") id: string,
    @Body() body: { contentProviderAccountId?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.contentProviderAccountId) throw normalizedError("VALIDATION_FAILED", "Chọn tài khoản content khác", requestId(response));
    const job = await this.jobs.switchContentAccount(id, user.id, user.role, body.contentProviderAccountId);
    if (!job) throw normalizedError("NOT_FOUND", "Không tìm thấy việc", requestId(response), 404);
    if (job === "same") throw normalizedError("VALIDATION_FAILED", "Chọn tài khoản content khác tài khoản đang dùng", requestId(response));
    if (job === "provider") throw normalizedError("VALIDATION_FAILED", "Tài khoản content không dùng được. Verify OpenAI, Gemini hoặc xAI trước.", requestId(response));
    return success(job, requestId(response));
  }

  @Post("jobs/:id/script/approve")
  async approve(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const job = await this.jobs.approve(id, user.id, user.role);
    if (!job) throw normalizedError("NOT_FOUND", "Không tìm thấy việc", requestId(response), 404);
    return success(job, requestId(response));
  }

  @Delete("jobs/:id")
  async remove(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.jobs.remove(id, user.id, user.role);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy việc", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("FORBIDDEN", "Không có quyền xóa việc này", requestId(response), 403);
    return success({ deleted: true }, requestId(response));
  }
}
