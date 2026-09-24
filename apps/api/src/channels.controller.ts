import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { ChannelsService } from "./channels.service.js";
import { normalizedError, success } from "./envelopes.js";

type ConnectBody = { name?: string; authType?: "token" | "api_key"; secret?: string };

@Controller()
export class ChannelsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Get("channels")
  async list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(await this.channels.list(user.id, user.role), requestId(response));
  }

  @Get("channels/:id/insights")
  async insights(@Param("id") id: string, @Query("period") period: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const detail = await this.channels.insights(id, user.id, user.role, period);
    if (!detail) throw normalizedError("NOT_FOUND", "Không tìm thấy kênh", requestId(response), 404);
    return success(detail, requestId(response));
  }

  @Get("channels/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const detail = await this.channels.get(id, user.id, user.role);
    if (!detail) throw normalizedError("NOT_FOUND", "Không tìm thấy kênh", requestId(response), 404);
    return success(detail, requestId(response));
  }

  @Post("channel-connections")
  async connect(@Body() body: ConnectBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (user.role !== "admin") throw normalizedError("FORBIDDEN", "Chỉ Admin được kết nối kênh TikTok", requestId(response), 403);
    if (!body.secret?.trim() || (body.authType !== "token" && body.authType !== "api_key")) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu token TikTok", requestId(response));
    }
    const channel = await this.channels.connectToken(user.id, { ...(body.name === undefined ? {} : { name: body.name }), secret: body.secret.trim(), authType: body.authType });
    if (channel === "invalid") throw normalizedError("PROVIDER_UNAVAILABLE", "Token TikTok không hợp lệ", requestId(response), 502);
    return success(channel, requestId(response));
  }

  @Post("channels/:id/sync")
  @HttpCode(200)
  async sync(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const detail = await this.channels.sync(id, user.id, user.role);
    if (!detail) throw normalizedError("NOT_FOUND", "Không tìm thấy kênh hoặc kênh đã vô hiệu", requestId(response), 404);
    if (detail === "invalid") throw normalizedError("PROVIDER_UNAVAILABLE", "Không đồng bộ được kênh TikTok", requestId(response), 502);
    return success(detail, requestId(response));
  }

  @Post("channels/:id/disable")
  @HttpCode(200)
  async disable(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.channels.disable(id, user.id, user.role);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy kênh", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("FORBIDDEN", "Chỉ Admin được vô hiệu kênh", requestId(response), 403);
    const detail = await this.channels.get(id, user.id, user.role);
    return success(detail, requestId(response));
  }
}
