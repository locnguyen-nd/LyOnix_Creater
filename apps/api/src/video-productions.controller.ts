import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { VideoProductionSubmitRequest } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { VideoProductionsService } from "./video-productions.service.js";

@Controller()
export class VideoProductionsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(VideoProductionsService) private readonly productions: VideoProductionsService,
  ) {}

  /**
   * One 202 submit runs the whole Auto DAG in the background — never blocks on a
   * provider call here (§5 "API không chờ provider/render trong request HTTP").
   */
  @Post("video-productions")
  async submit(@Body() body: Partial<VideoProductionSubmitRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.mode || !body.projectId?.trim() || !body.automationProfileId?.trim() || (!body.sourceId?.trim() && !body.source)) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu mode/projectId/automationProfileId hoặc (sourceId | source)", requestId(response));
    }
    const outcome = await this.productions.submit(user.id, user.role, body as VideoProductionSubmitRequest);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    response.status(202);
    return success(outcome.data, requestId(response));
  }

  @Get("video-productions/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.productions.get(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  /** Poll-based progress feed (§5 allows SSE hoặc poll — poll here, matching every other VE2E-06..08 status endpoint in this codebase so far). */
  @Get("video-productions/:id/events")
  async events(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.productions.listEvents(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }
}
