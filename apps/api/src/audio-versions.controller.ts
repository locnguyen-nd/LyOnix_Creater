import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { AudioVersionsService } from "./audio-versions.service.js";

type GenerateBody = { providerAccountId?: string; voiceId?: string; modelId?: string };

@Controller()
export class AudioVersionsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AudioVersionsService) private readonly audioVersions: AudioVersionsService,
  ) {}

  @Get("scene-versions/:id/audio-versions")
  async list(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.audioVersions.list(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Post("scene-versions/:id/audio-versions")
  async generate(@Param("id") id: string, @Body() body: GenerateBody, @Headers("idempotency-key") idempotencyKey: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.providerAccountId?.trim() || !body.voiceId?.trim() || !idempotencyKey?.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu providerAccountId/voiceId hoặc Idempotency-Key", requestId(response));
    }
    const outcome = await this.audioVersions.generate(id, user.id, user.role, {
      providerAccountId: body.providerAccountId,
      voiceId: body.voiceId,
      idempotencyKey,
      ...(body.modelId ? { modelId: body.modelId } : {}),
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    response.status(202);
    response.setHeader("Location", `/api/v1/audio-generation-operations/${outcome.data.operationId}`);
    return success({ ...outcome.data, pollUrl: `/api/v1/audio-generation-operations/${outcome.data.operationId}` }, requestId(response));
  }

  @Get("audio-generation-operations/:id")
  async getOperation(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.audioVersions.getOperation(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }
}
