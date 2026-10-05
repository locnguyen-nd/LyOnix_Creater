import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { createReadStream } from "node:fs";
import type { CreatomatePreviewConfigResponse, OrshotRenderOptions, RenderAssignmentInput, RenderEngine } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { creatomatePreviewConfigured, creatomatePreviewPublicToken } from "./creatomate-preview.config.js";
import { normalizedError, success } from "./envelopes.js";
import { RenderJobsService } from "./render-jobs.service.js";

type SubmitBody = {
  templateSnapshotId?: string;
  providerAccountId?: string;
  assignments?: RenderAssignmentInput[];
  outputFormat?: "mp4" | "mov" | "gif";
  idempotencyKey?: string;
  allowTemplateTts?: boolean;
  orshot?: OrshotRenderOptions;
  /** VE2E-113: admin-only engine override; omitted = the Router decides. */
  forceEngine?: RenderEngine;
};

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;
const ENGINES: readonly string[] = ["lyonix", "creatomate", "orshot"];

@Controller()
export class RenderJobsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RenderJobsService) private readonly renders: RenderJobsService,
  ) {}

  @Post("projects/:projectId/render-jobs")
  async submit(@Param("projectId") projectId: string, @Body() body: SubmitBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.templateSnapshotId?.trim() || !body.providerAccountId?.trim() || !Array.isArray(body.assignments) || body.assignments.length === 0) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu templateSnapshotId/providerAccountId/assignments để submit render", requestId(response));
    }
    const outcome = await this.renders.submit(projectId, user.id, user.role, {
      templateSnapshotId: body.templateSnapshotId,
      providerAccountId: body.providerAccountId,
      assignments: body.assignments,
      ...(body.outputFormat ? { outputFormat: body.outputFormat } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(body.allowTemplateTts === true ? { allowTemplateTts: true } : {}),
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  /** VE2E-07: submits a render from an approved Studio `TimelineVersion` (see `RenderJobsService.submitFromTimelineVersion`). */
  @Post("projects/:projectId/timeline-versions/:timelineVersionId/render-jobs")
  async submitFromTimeline(
    @Param("projectId") projectId: string,
    @Param("timelineVersionId") timelineVersionId: string,
    @Body() body: SubmitBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.providerAccountId?.trim()) throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId để submit render", requestId(response));
    const outcome = await this.renders.enqueueTimelineRender(projectId, timelineVersionId, user.id, user.role, {
      providerAccountId: body.providerAccountId,
      ...(body.outputFormat ? { outputFormat: body.outputFormat } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(body.allowTemplateTts === true ? { allowTemplateTts: true } : {}),
      ...(body.orshot ? { orshot: body.orshot } : {}),
      ...(body.forceEngine && ENGINES.includes(body.forceEngine) ? { forceEngine: body.forceEngine } : {}),
    }, "template");
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    response.status(202);
    return success(outcome.data, requestId(response));
  }

  /** Orshot pre-render cost estimate (narration seconds -> credits -> USD). Read-only, never calls Orshot. */
  @Get("projects/:projectId/timeline-versions/:timelineVersionId/orshot-estimate")
  async orshotEstimate(
    @Param("projectId") projectId: string,
    @Param("timelineVersionId") timelineVersionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.renders.estimateOrshotRender(projectId, timelineVersionId, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  /**
   * Renders every scene the Studio timeline actually has (not capped by however many
   * `Image-N`/`Voiceover-N` slots the pinned template's own author drew) — see
   * `RenderJobsService.submitDynamicFromTimeline`. The pinned template still supplies
   * caption/image visual style, just not the scene count.
   */
  @Post("projects/:projectId/timeline-versions/:timelineVersionId/dynamic-render-jobs")
  async submitDynamicFromTimeline(
    @Param("projectId") projectId: string,
    @Param("timelineVersionId") timelineVersionId: string,
    @Body() body: SubmitBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.providerAccountId?.trim()) throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId để submit render", requestId(response));
    const outcome = await this.renders.enqueueTimelineRender(projectId, timelineVersionId, user.id, user.role, {
      providerAccountId: body.providerAccountId,
      ...(body.outputFormat ? { outputFormat: body.outputFormat } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      ...(body.forceEngine && ENGINES.includes(body.forceEngine) ? { forceEngine: body.forceEngine } : {}),
    }, "dynamic");
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    response.status(202);
    return success(outcome.data, requestId(response));
  }

  /**
   * VE2E-13: read-only Studio preview of the dynamic render `source` JSON — no Creatomate
   * call, no `RenderJob` row. Works on a draft timeline, unlike the submit endpoints above.
   */
  @Get("projects/:projectId/timeline-versions/:timelineVersionId/dynamic-preview-source")
  async dynamicPreviewSource(
    @Param("projectId") projectId: string,
    @Param("timelineVersionId") timelineVersionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.renders.previewDynamicComposition(projectId, timelineVersionId, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  /**
   * VE2E-13: whether the Creatomate Preview SDK's browser-side public token is configured
   * (B10/B11-gated, see `creatomate-preview.config.ts`) — never the render API secret, which
   * never leaves the server. Auth-gated even though the token itself is not sensitive by
   * Creatomate's own design, consistent with every other config-exposure endpoint here.
   */
  @Get("creatomate/preview-config")
  async previewConfig(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const body: CreatomatePreviewConfigResponse = { configured: creatomatePreviewConfigured(), publicToken: creatomatePreviewPublicToken() };
    return success(body, requestId(response));
  }

  @Get("render-jobs/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.renders.get(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  /** VE2E-110: streams the finished video of an internal render (Range supported, so `<video>` can seek). Auth + project access; never a path from the client. */
  @Get("render-jobs/:id/file")
  async file(@Param("id") id: string, @Headers("range") range: string | undefined, @Req() request: Request, @Res() response: Response) {
    await this.streamOutput(id, "video", range, request, response);
  }

  /** VE2E-110: the cover image (JPG 1080x1920) of an internal render. */
  @Get("render-jobs/:id/thumbnail")
  async thumbnail(@Param("id") id: string, @Req() request: Request, @Res() response: Response) {
    await this.streamOutput(id, "thumbnail", undefined, request, response);
  }

  private async streamOutput(id: string, kind: "video" | "thumbnail", range: string | undefined, request: Request, response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.renders.resolveInternalOutput(id, user.id, user.role, kind);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    const file = outcome.data;
    response.setHeader("Content-Type", file.mimeType);
    response.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Accept-Ranges", "bytes");
    const match = range ? RANGE_RE.exec(range) : null;
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : file.bytes - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= file.bytes) {
        response.status(416).setHeader("Content-Range", `bytes */${file.bytes}`).end();
        return;
      }
      response.status(206);
      response.setHeader("Content-Range", `bytes ${start}-${end}/${file.bytes}`);
      response.setHeader("Content-Length", String(end - start + 1));
      createReadStream(file.absolutePath, { start, end }).pipe(response);
      return;
    }
    response.setHeader("Content-Length", String(file.bytes));
    createReadStream(file.absolutePath).pipe(response);
  }

  /** Manual poll/reconcile fallback trigger for one job — periodic invocation across all pending jobs is left to an external scheduler (see handoff). */
  @Post("render-jobs/:id/reconcile")
  @HttpCode(200)
  async reconcile(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    // Reuse `get` for the access-control check (project grant), then force a live reconcile pass.
    const access = await this.renders.get(id, user.id, user.role);
    if (!access.ok) throw normalizedError(access.code, access.message, requestId(response), access.status ?? 400, [], access.retryable ?? false);
    const outcome = await this.renders.reconcileOne(id);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  /**
   * Public Creatomate webhook receiver — no session cookie, no CSRF (Creatomate is a
   * third-party server, not a browser). Authenticated solely by the unguessable
   * per-job `token` embedded in the URL LyOnix gave Creatomate at submit time.
   */
  @Post("render-webhooks/orshot/:token")
  @HttpCode(200)
  async orshotWebhook(@Param("token") token: string, @Res({ passthrough: true }) response: Response) {
    const outcome = await this.renders.handleOrshotWebhook(token);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Post("render-webhooks/creatomate/:token")
  @HttpCode(200)
  async webhook(@Param("token") token: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const outcome = await this.renders.handleWebhook(token, body);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }
}
