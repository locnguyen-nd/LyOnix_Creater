import { Body, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ScriptDraftV2Response } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { ScriptVersionsService } from "./script-versions.service.js";

type ProviderPinBody = { accountId?: string; provider?: string; modelId?: string; configVersion?: number; promptTemplateVersion?: string };
type CreateBody = { draft?: ScriptDraftV2Response; providerPin?: ProviderPinBody };

@Controller()
export class ScriptVersionsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ScriptVersionsService) private readonly scriptVersions: ScriptVersionsService,
  ) {}

  @Get("sources/:id/script-versions")
  async list(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.scriptVersions.list(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Post("sources/:id/script-versions")
  async create(@Param("id") id: string, @Body() body: CreateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const pin = body.providerPin;
    if (!body.draft || !pin?.accountId || !pin.provider || !pin.modelId || !pin.configVersion || !pin.promptTemplateVersion) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu draft/providerPin để lưu script version", requestId(response));
    }
    const outcome = await this.scriptVersions.create(id, user.id, user.role, {
      draft: body.draft,
      providerPin: {
        accountId: pin.accountId,
        provider: pin.provider,
        modelId: pin.modelId,
        configVersion: pin.configVersion,
        promptTemplateVersion: pin.promptTemplateVersion,
      },
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Get("script-versions/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const outcome = await this.scriptVersions.get(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }

  @Post("script-versions/:id/approve")
  async approve(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.scriptVersions.approve(id, user.id, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return success(outcome.data, requestId(response));
  }
}
