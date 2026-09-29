import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { SaveTimelineVersionRequest, TimelineOptionValues, TimelineSceneBindingInput, TimelineSegmentInput } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { TimelineVersionsService } from "./timeline-versions.service.js";

type SaveBody = { supersedesId?: string | null; templateSnapshotId?: string | null; scenes?: TimelineSceneBindingInput[]; optionValues?: TimelineOptionValues; segments?: TimelineSegmentInput[] };

@Controller()
export class TimelineVersionsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TimelineVersionsService) private readonly timelines: TimelineVersionsService,
  ) {}

  @Get("projects/:projectId/timeline-versions")
  async list(@Param("projectId") projectId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.timelines.list(projectId, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Get("projects/:projectId/timeline-versions/latest")
  async latest(@Param("projectId") projectId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.timelines.latest(projectId, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Post("projects/:projectId/timeline-versions")
  async save(@Param("projectId") projectId: string, @Body() body: SaveBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!Array.isArray(body.scenes) || body.scenes.length === 0) throw normalizedError("VALIDATION_FAILED", "Thiếu scenes cho timeline", requestId(response));
    const input: SaveTimelineVersionRequest = {
      supersedesId: body.supersedesId ?? null,
      scenes: body.scenes,
      ...(body.templateSnapshotId !== undefined ? { templateSnapshotId: body.templateSnapshotId } : {}),
      ...(body.optionValues ? { optionValues: body.optionValues } : {}),
      // VE2E-42: optional; shape is validated in the service (non-array -> VALIDATION_FAILED).
      ...(body.segments !== undefined && body.segments !== null ? { segments: body.segments } : {}),
    };
    const outcome = await this.timelines.save(projectId, user.id, user.role, input);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Get("timeline-versions/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.timelines.get(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Post("timeline-versions/:id/approve")
  async approve(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.timelines.approve(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Get("timeline-versions/:id/preview")
  async preview(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.timelines.preview(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }
}
