import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { PexelsMediaType } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { PexelsService } from "./pexels.service.js";

type ImportBody = {
  providerAccountId?: string;
  type?: PexelsMediaType;
  externalId?: string;
  folderId?: string | null;
  reusable?: boolean;
  sceneId?: string | null;
};

const isMediaType = (value: unknown): value is PexelsMediaType => value === "photo" || value === "video";

@Controller()
export class PexelsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PexelsService) private readonly pexels: PexelsService,
  ) {}

  @Get("projects/:projectId/pexels/search")
  async search(
    @Param("projectId") projectId: string,
    @Query("providerAccountId") providerAccountId: string | undefined,
    @Query("type") type: string | undefined,
    @Query("query") query: string | undefined,
    @Query("page") page: string | undefined,
    @Query("perPage") perPage: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user } = await requireUser(request, response, this.auth);
    if (!providerAccountId?.trim() || !isMediaType(type) || !query?.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId/type/query cho tìm kiếm Pexels", requestId(response));
    }
    const outcome = await this.pexels.search(projectId, user.id, user.role, {
      providerAccountId,
      type,
      query,
      ...(page ? { page: Number(page) } : {}),
      ...(perPage ? { perPage: Number(perPage) } : {}),
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Post("projects/:projectId/pexels/import")
  async import(@Param("projectId") projectId: string, @Body() body: ImportBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.providerAccountId?.trim() || !isMediaType(body.type) || !body.externalId?.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId/type/externalId để import từ Pexels", requestId(response));
    }
    const outcome = await this.pexels.import(projectId, user.id, user.role, {
      providerAccountId: body.providerAccountId,
      type: body.type,
      externalId: body.externalId,
      folderId: body.folderId ?? null,
      reusable: body.reusable ?? true,
      sceneId: body.sceneId ?? null,
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }
}
