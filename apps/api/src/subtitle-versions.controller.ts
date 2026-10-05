import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ResetSubtitleVersionRequest, SaveSubtitleVersionRequest } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { SubtitleVersionsService, type SubtitleVersionOutcome } from "./subtitle-versions.service.js";

/** V03-03: list / edit / reset the timed captions of one voice (`AudioVersion`). */
@Controller()
export class SubtitleVersionsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SubtitleVersionsService) private readonly subtitles: SubtitleVersionsService,
  ) {}

  private unwrap<T>(outcome: SubtitleVersionOutcome<T>, response: Response): T {
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, outcome.details ?? []);
    return outcome.data;
  }

  @Get("audio-versions/:id/subtitle-versions")
  async list(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(this.unwrap(await this.subtitles.list(id, user.id, user.role), response), requestId(response));
  }

  @Post("audio-versions/:id/subtitle-versions")
  async save(@Param("id") id: string, @Body() body: Partial<SaveSubtitleVersionRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.subtitles.saveEdit(id, user.id, user.role, { basedOnSubtitleVersionId: body?.basedOnSubtitleVersionId, cues: body?.cues });
    return success(this.unwrap(outcome, response), requestId(response));
  }

  @Post("audio-versions/:id/subtitle-versions/reset")
  async reset(@Param("id") id: string, @Body() body: Partial<ResetSubtitleVersionRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.subtitles.resetToAuto(id, user.id, user.role, { basedOnSubtitleVersionId: body?.basedOnSubtitleVersionId });
    return success(this.unwrap(outcome, response), requestId(response));
  }
}
