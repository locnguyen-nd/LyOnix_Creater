import { Body, Controller, Get, Inject, Param, Patch, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { RenderEngineAdminService } from "./render-engine-admin.service.js";

type TemplateBody = { rolloutPercent?: unknown; fallbackSnapshotIds?: unknown };

/** VE2E-118: admin-only rollout controls + metrics of the self-render engine. */
@Controller("admin/render-engine")
export class RenderEngineAdminController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RenderEngineAdminService) private readonly admin: RenderEngineAdminService,
  ) {}

  private async requireAdmin(request: Request, response: Response) {
    const session = await requireUser(request, response, this.auth);
    if (session.user.role !== "admin") throw normalizedError("FORBIDDEN", "Chỉ Admin được quản lý engine render nội bộ", requestId(response), 403);
    return session;
  }

  @Get()
  async overview(@Query("days") days: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.requireAdmin(request, response);
    return success(await this.admin.overview(days === undefined ? 7 : Number(days)), requestId(response));
  }

  @Patch("templates/:snapshotId")
  async updateTemplate(@Param("snapshotId") snapshotId: string, @Body() body: TemplateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await this.requireAdmin(request, response);
    requireCsrf(request, response, session);
    const outcome = await this.admin.updateTemplate(snapshotId, body ?? {}, user.id);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status);
    return success(outcome.data, requestId(response));
  }
}
