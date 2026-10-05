import { Body, Controller, Delete, Get, Inject, Param, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { SaveCreationPreferencesRequest, SaveUserDraftRequest } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { CreationPreferencesService } from "./creation-preferences.service.js";
import { normalizedError, success } from "./envelopes.js";
import { UserDraftsService } from "./user-drafts.service.js";

type Outcome<T> = { ok: true; data: T } | { ok: false; code: Parameters<typeof normalizedError>[0]; message: string; status?: number };

/**
 * VE2E-124: the signed-in user's own draft of a creation flow and own creation defaults. The user always comes from the session,
 * never from the URL or body, so nobody (admin included) can read or overwrite another user's draft/defaults through this API.
 */
@Controller()
export class MeCreationController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(UserDraftsService) private readonly drafts: UserDraftsService,
    @Inject(CreationPreferencesService) private readonly preferences: CreationPreferencesService,
  ) {}

  private unwrap<T>(outcome: Outcome<T>, response: Response): T {
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400);
    return outcome.data;
  }

  @Get("me/drafts/:flowType")
  async getDraft(@Param("flowType") flowType: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(this.unwrap(await this.drafts.get(user.id, flowType), response), requestId(response));
  }

  @Put("me/drafts/:flowType")
  async saveDraft(@Param("flowType") flowType: string, @Body() body: Partial<SaveUserDraftRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    return success(this.unwrap(await this.drafts.save(user.id, flowType, { payload: body?.payload, baseVersion: body?.baseVersion }), response), requestId(response));
  }

  @Delete("me/drafts/:flowType")
  async deleteDraft(@Param("flowType") flowType: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    return success(this.unwrap(await this.drafts.remove(user.id, flowType), response), requestId(response));
  }

  @Get("me/creation-preferences")
  async getPreferences(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(this.unwrap(await this.preferences.get(user.id), response), requestId(response));
  }

  @Put("me/creation-preferences")
  async savePreferences(@Body() body: Partial<SaveCreationPreferencesRequest>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    return success(this.unwrap(await this.preferences.save(user.id, user.role, { options: body?.options }), response), requestId(response));
  }

  @Delete("me/creation-preferences")
  async resetPreferences(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    return success(this.unwrap(await this.preferences.reset(user.id), response), requestId(response));
  }
}
