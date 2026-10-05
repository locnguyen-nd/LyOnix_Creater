import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import type { AutomationProfileConfig } from "./automation-profiles.service.js";
import { AutomationProfilesService } from "./automation-profiles.service.js";

@Controller()
export class AutomationProfilesController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(AutomationProfilesService) private readonly profiles: AutomationProfilesService) {}

  @Get("automation-profiles")
  async list(@Query("projectId") projectId: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const result = await this.profiles.list(user.id, user.role, projectId);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    return success(result, requestId(response));
  }

  @Get("automation-profiles/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const result = await this.profiles.get(id, user.id, user.role);
    if (!result || result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy automation profile", requestId(response), 404);
    return success(result, requestId(response));
  }

  @Post("automation-profiles")
  async create(@Body() body: Partial<AutomationProfileConfig>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.name || !body.contentConfig || !body.voiceConfig || !body.outputPreset || !body.durationSec || !body.sceneCount || !body.costCeiling) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu cấu hình automation profile", requestId(response));
    }
    const result = await this.profiles.create(user.id, user.role, body as AutomationProfileConfig);
    if (result === "forbidden") throw normalizedError("FORBIDDEN", "Không có quyền tạo automation profile trong dự án này", requestId(response), 403);
    if (result === "invalid") throw normalizedError("VALIDATION_FAILED", "Cấu hình automation profile không hợp lệ", requestId(response));
    return success(result, requestId(response));
  }
}
