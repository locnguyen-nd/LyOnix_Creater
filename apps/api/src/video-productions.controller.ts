import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { VideoProductionSubmitRequest } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { AutoPreflightService } from "./auto-preflight.service.js";
import { VideoProductionsService } from "./video-productions.service.js";

type AutoSetupBody = {
  name?: string;
  contentAccountId?: string;
  voiceAccountId?: string;
  voiceId?: string;
  mediaAccountId?: string;
  renderAccountId?: string;
  templateSnapshotId?: string;
  renderOptions?: unknown;
  /** VE2E-94: the chosen caption preset, resolved to whole-video caption option values (validated by the service). */
  captionStyle?: unknown;
  locale?: string;
  durationSec?: number;
  sceneCount?: number;
  /** Preflight only: the template picked in the form before it is pinned. */
  externalTemplateId?: string;
};

@Controller()
export class VideoProductionsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(VideoProductionsService) private readonly productions: VideoProductionsService,
    @Inject(AutoPreflightService) private readonly preflight: AutoPreflightService,
  ) {}

  /**
   * Render reliability: read-only check of everything an Auto job needs (workers, render account + template, PUBLIC_BASE_URL,
   * content model quota, voice, media) for the create-video form, before anything is created or paid. Submit runs the same checks.
   */
  @Post("video-productions/preflight")
  async preflightCheck(@Body() body: AutoSetupBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.preflight.check(user.id, user.role, {
      contentAccountId: body.contentAccountId?.trim() ?? "",
      voiceAccountId: body.voiceAccountId?.trim() ?? "",
      voiceId: body.voiceId?.trim() ?? "",
      mediaAccountId: body.mediaAccountId?.trim() ?? "",
      renderAccountId: body.renderAccountId?.trim() ?? "",
      templateSnapshotId: body.templateSnapshotId?.trim() ?? "",
      ...(body.externalTemplateId?.trim() ? { externalTemplateId: body.externalTemplateId.trim() } : {}),
      sceneCount: typeof body.sceneCount === "number" ? body.sceneCount : null,
    });
    return success(result, requestId(response));
  }

  /** Render reliability: are the background workers (workflow, audio, media-worker) running? */
  @Get("system/workers")
  async workers(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    return success(await this.preflight.workerHealth(), requestId(response));
  }

  /** VE2E-08: provisions the Project + AutomationProfileVersion a one-click Auto submit needs - see VideoProductionsService.setupAutoProfile. */
  @Post("video-productions/auto-setup")
  async autoSetup(@Body() body: AutoSetupBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.name?.trim() || !body.contentAccountId?.trim() || !body.voiceAccountId?.trim() || !body.voiceId?.trim() || !body.mediaAccountId?.trim() || !body.renderAccountId?.trim() || !body.templateSnapshotId?.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu name/contentAccountId/voiceAccountId/voiceId/mediaAccountId/renderAccountId/templateSnapshotId", requestId(response));
    }
    const outcome = await this.productions.setupAutoProfile(user.id, user.role, {
      name: body.name,
      contentAccountId: body.contentAccountId,
      voiceAccountId: body.voiceAccountId,
      voiceId: body.voiceId,
      mediaAccountId: body.mediaAccountId,
      renderAccountId: body.renderAccountId,
      templateSnapshotId: body.templateSnapshotId,
      ...(body.renderOptions !== undefined ? { renderOptions: body.renderOptions } : {}),
      ...(body.captionStyle !== undefined ? { captionStyle: body.captionStyle } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
      ...(body.durationSec ? { durationSec: body.durationSec } : {}),
      ...(body.sceneCount ? { sceneCount: body.sceneCount } : {}),
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

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

  /** VE2E-22: `projectId` is optional — see `VideoProductionsService.list()` for why omitting it (list everything the caller created) is the actual fix, not just a convenience default. */
  @Get("video-productions")
  async list(@Query("projectId") projectId: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.productions.list(user.id, user.role, projectId?.trim() || undefined);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Get("video-productions/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.productions.get(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Delete("video-productions/:id")
  async remove(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.productions.remove(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  /** VE2E-62: take a still-queued (draft) run out of the queue. */
  @Post("video-productions/:id/cancel")
  async cancel(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.productions.cancelQueued(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Post("video-productions/:id/retry")
  async retry(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.productions.retry(id, user.id, user.role);
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
