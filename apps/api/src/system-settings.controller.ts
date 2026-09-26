import { Body, Controller, Get, Inject, Patch, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { SystemSettingsService } from "./system-settings.service.js";
import { TiktokSyncSchedulerService } from "./tiktok-sync-scheduler.service.js";

type PatchBody = { channelSyncIntervalMinutes?: number };

@Controller()
export class SystemSettingsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SystemSettingsService) private readonly settings: SystemSettingsService,
    @Inject(TiktokSyncSchedulerService) private readonly scheduler: TiktokSyncSchedulerService,
  ) {}

  private async admin(request: Request, response: Response) {
    const session = await requireUser(request, response, this.auth);
    if (session.user.role !== "admin") {
      throw normalizedError("FORBIDDEN", "Chỉ Admin được xem/sửa cài đặt hệ thống", requestId(response), 403);
    }
    return session;
  }

  @Get("system-settings")
  async get(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.admin(request, response);
    return success(await this.settings.load(), requestId(response));
  }

  @Patch("system-settings")
  async patch(
    @Body() body: PatchBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { session } = await this.admin(request, response);
    requireCsrf(request, response, session);
    if (body.channelSyncIntervalMinutes !== undefined) {
      const n = Number(body.channelSyncIntervalMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 60) {
        throw normalizedError("VALIDATION_FAILED", "Thời gian đồng bộ kênh phải từ 1–60 phút", requestId(response));
      }
    }
    const updated = await this.settings.update(
      body.channelSyncIntervalMinutes === undefined
        ? {}
        : { channelSyncIntervalMinutes: body.channelSyncIntervalMinutes },
    );
    this.scheduler.reschedule(updated.channelSyncIntervalMinutes);
    return success(updated, requestId(response));
  }
}
