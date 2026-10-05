import { Body, Controller, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { ScriptGenerationService } from "./script-generation.service.js";

type GenerateBody = { providerAccountId?: string; language?: string; direction?: string };

@Controller()
export class ScriptGenerationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ScriptGenerationService) private readonly scriptGeneration: ScriptGenerationService,
  ) {}

  @Post("sources/:id/script-drafts")
  async generate(@Param("id") id: string, @Body() body: GenerateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const providerAccountId = body.providerAccountId?.trim();
    const outcome = await this.scriptGeneration.generate(id, user.id, user.role, {
      ...(providerAccountId ? { providerAccountId } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(body.direction ? { direction: body.direction } : {}),
    });
    if (!outcome) throw normalizedError("NOT_FOUND", "Không tìm thấy nguồn", requestId(response), 404);
    if (outcome === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy nguồn", requestId(response), 404);
    if (!outcome.ok) {
      throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    }
    return success(outcome.response, requestId(response));
  }
}
