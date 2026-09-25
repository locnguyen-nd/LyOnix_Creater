import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { StudioBridgeService } from "./studio-bridge.service.js";

@Controller()
export class StudioBridgeController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(StudioBridgeService) private readonly bridge: StudioBridgeService,
  ) {}

  @Get("jobs/:jobId/studio/context")
  async context(@Param("jobId") jobId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.bridge.ensureContext(jobId, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }
}
