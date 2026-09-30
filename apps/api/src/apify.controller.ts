import { Body, Controller, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ApifyImportRequest, ApifySearchRequest } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { ApifyService } from "./apify.service.js";
import { normalizedError, success } from "./envelopes.js";

/** VE2E-34: Studio Apify tab. Both routes are CSRF-protected POSTs (search runs a paid Actor; import writes an asset). admin|staff with project access. */
@Controller()
export class ApifyController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ApifyService) private readonly apify: ApifyService,
  ) {}

  @Post("projects/:projectId/apify/search")
  async search(@Param("projectId") projectId: string, @Body() body: Partial<ApifySearchRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (typeof body.providerAccountId !== "string" || !body.providerAccountId.trim() || typeof body.platform !== "string" || typeof body.query !== "string" || !body.query.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId/platform/query cho tìm kiếm Apify", requestId(response));
    }
    const outcome = await this.apify.search(projectId, user.id, user.role, {
      providerAccountId: body.providerAccountId.trim(),
      platform: body.platform,
      query: body.query,
      ...(typeof body.lang === "string" ? { lang: body.lang } : {}),
      ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Post("projects/:projectId/apify/import")
  async import(@Param("projectId") projectId: string, @Body() body: Partial<ApifyImportRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (typeof body.providerAccountId !== "string" || !body.providerAccountId.trim() || typeof body.importRef !== "string" || !body.importRef.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId/importRef để import từ Apify", requestId(response));
    }
    const outcome = await this.apify.import(projectId, user.id, user.role, {
      providerAccountId: body.providerAccountId.trim(),
      importRef: body.importRef.trim(),
      folderId: body.folderId ?? null,
      reusable: body.reusable ?? true,
      sceneId: body.sceneId ?? null,
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }
}
