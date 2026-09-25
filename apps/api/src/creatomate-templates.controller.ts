import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";

type SnapshotBody = { providerAccountId?: string; externalTemplateId?: string };

@Controller()
export class CreatomateTemplatesController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CreatomateTemplatesService) private readonly templates: CreatomateTemplatesService,
  ) {}

  @Get("creatomate/templates")
  async list(@Query("providerAccountId") providerAccountId: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    if (!providerAccountId?.trim()) throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId", requestId(response));
    const outcome = await this.templates.listTemplates(providerAccountId);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Post("creatomate/template-snapshots")
  async snapshot(@Body() body: SnapshotBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.providerAccountId?.trim() || !body.externalTemplateId?.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId/externalTemplateId", requestId(response));
    }
    const outcome = await this.templates.snapshot(body.providerAccountId, body.externalTemplateId, user.id);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Get("creatomate/template-snapshots/:id")
  async getSnapshot(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const outcome = await this.templates.getSnapshot(id);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }
}
