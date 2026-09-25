import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import type { CreateSourceInput } from "./sources.service.js";
import { SourcesService } from "./sources.service.js";

type CreateBody = {
  type?: "topic" | "raw_script" | "article_url" | "file";
  topic?: string;
  rawScript?: string;
  url?: string;
  originalFileName?: string;
  mimeType?: string;
  checksumSha256?: string;
};

const toInput = (body: CreateBody): CreateSourceInput | null => {
  if (body.type === "topic") return { type: "topic", topic: body.topic ?? "" };
  if (body.type === "raw_script") return { type: "raw_script", rawScript: body.rawScript ?? "" };
  if (body.type === "article_url") return { type: "article_url", url: body.url ?? "" };
  if (body.type === "file") return { type: "file", originalFileName: body.originalFileName ?? "", mimeType: body.mimeType ?? "", checksumSha256: body.checksumSha256 ?? "" };
  return null;
};

@Controller()
export class SourcesController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SourcesService) private readonly sources: SourcesService) {}

  @Get("projects/:projectId/sources")
  async list(@Param("projectId") projectId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const result = await this.sources.list(projectId, user.id, user.role);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    return success(result, requestId(response));
  }

  @Get("sources/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const result = await this.sources.get(id, user.id, user.role);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy nguồn", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy nguồn", requestId(response), 404);
    return success(result, requestId(response));
  }

  @Post("projects/:projectId/sources")
  async create(@Param("projectId") projectId: string, @Body() body: CreateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const input = toInput(body);
    if (!input) throw normalizedError("VALIDATION_FAILED", "Loại nguồn không hợp lệ", requestId(response));
    const result = await this.sources.create(projectId, user.id, user.role, input);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    if (result === "invalid") throw normalizedError("VALIDATION_FAILED", "Dữ liệu nguồn không hợp lệ", requestId(response));
    if (result === "ssrf_blocked") throw normalizedError("SSRF_BLOCKED", "URL bị chặn (localhost/private/không hỗ trợ scheme)", requestId(response), 400);
    return success(result, requestId(response));
  }

  @Post("sources/:id/extract")
  async extract(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.sources.extractArticle(id, user.id, user.role);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy nguồn", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy nguồn", requestId(response), 404);
    if (result === "invalid_type") throw normalizedError("VALIDATION_FAILED", "Chỉ nguồn article_url mới cần trích xuất", requestId(response));
    if ("extractFailed" in result) {
      const code = result.extractFailed === "ssrf_blocked" ? "SSRF_BLOCKED" : "VALIDATION_FAILED";
      throw normalizedError(code, `Không trích xuất được nội dung URL: ${result.extractFailed}`, requestId(response), code === "SSRF_BLOCKED" ? 400 : 502);
    }
    return success(result, requestId(response));
  }
}
