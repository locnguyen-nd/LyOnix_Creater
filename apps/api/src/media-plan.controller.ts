import { Body, Controller, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { MediaPlanRequest } from "@lyonix/contracts";
import { parseBackgroundSegmentsSetting, resolveBackgroundSegmentRange } from "@lyonix/domain";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { MediaPlanService } from "./media-plan.service.js";
import { backgroundSegmentBoundsFromEnv } from "./video-productions.service.js";

/** VE2E-31: Studio entry to the server-side MediaPlanService (UI is VE2E-41). admin|staff with write access to the project. */
@Controller()
export class MediaPlanController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(MediaPlanService) private readonly mediaPlans: MediaPlanService,
  ) {}

  @Post("projects/:projectId/media-plans")
  async plan(@Param("projectId") projectId: string, @Body() body: Partial<MediaPlanRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const scriptDraftVersionId = typeof body.scriptDraftVersionId === "string" ? body.scriptDraftVersionId.trim() : "";
    const providerAccountId = typeof body.providerAccountId === "string" ? body.providerAccountId.trim() : "";
    if (!scriptDraftVersionId || !providerAccountId) throw normalizedError("VALIDATION_FAILED", "Thiếu scriptDraftVersionId hoặc providerAccountId", requestId(response));
    const setting = parseBackgroundSegmentsSetting(body.backgroundSegments, backgroundSegmentBoundsFromEnv());
    if (!setting.ok) throw normalizedError("VALIDATION_FAILED", setting.message, requestId(response));
    const outcome = await this.mediaPlans.planForScriptVersion(projectId, user.id, user.role, {
      scriptDraftVersionId,
      providerAccountId,
      // Studio has no intake target duration: auto resolves against the scenes' real total voice duration (VE2E-40 rule).
      range: (totalVoiceSeconds) => resolveBackgroundSegmentRange(setting.value, totalVoiceSeconds),
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }
}
