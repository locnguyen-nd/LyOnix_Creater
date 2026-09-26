import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { RenderAssignmentInput } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { RenderJobsService } from "./render-jobs.service.js";

type SubmitBody = {
  templateSnapshotId?: string;
  providerAccountId?: string;
  assignments?: RenderAssignmentInput[];
  outputFormat?: "mp4" | "mov" | "gif";
  idempotencyKey?: string;
};

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
    const outcome = await this.renders.submitFromTimelineVersion(projectId, timelineVersionId, user.id, user.role, {
      providerAccountId: body.providerAccountId,
      ...(body.outputFormat ? { outputFormat: body.outputFormat } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
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
    const outcome = await this.renders.submitDynamicFromTimeline(projectId, timelineVersionId, user.id, user.role, {
      providerAccountId: body.providerAccountId,
      ...(body.outputFormat ? { outputFormat: body.outputFormat } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Get("render-jobs/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.renders.get(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
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
  @Post("render-webhooks/creatomate/:token")
  @HttpCode(200)
  async webhook(@Param("token") token: string, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const outcome = await this.renders.handleWebhook(token, body);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }
}
