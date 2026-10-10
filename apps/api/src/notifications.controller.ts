import { Controller, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { NotificationsService } from "./notifications.service.js";

/** VE2E-158: the signed-in user's in-app notifications (dashboard bell). */
@Controller("notifications")
export class NotificationsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  async list(@Query("unread") unread: string | undefined, @Query("limit") limit: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(await this.notifications.list(user.id, { unreadOnly: unread === "1" || unread === "true", ...(limit ? { limit: Number(limit) } : {}) }), requestId(response));
  }

  @Get("unread-count")
  async unreadCount(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success({ unread: await this.notifications.unreadCount(user.id) }, requestId(response));
  }

  @Post("read-all")
  async readAll(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    return success({ marked: await this.notifications.markAllRead(user.id) }, requestId(response));
  }

  @Post(":id/read")
  async read(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!(await this.notifications.markRead(user.id, id))) throw normalizedError("NOT_FOUND", "Không tìm thấy thông báo", requestId(response), 404);
    return success({ id }, requestId(response));
  }
}
