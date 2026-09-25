import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { ProviderCapabilitiesService } from "./provider-capabilities.service.js";

@Controller()
export class ProviderCapabilitiesController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(ProviderCapabilitiesService) private readonly capabilities: ProviderCapabilitiesService) {}

  @Get("provider-capabilities/preflight")
  async preflight(
    @Query("profileId") profileId: string | undefined,
    @Query("pexelsAccountId") pexelsAccountId: string | undefined,
    @Query("creatomateAccountId") creatomateAccountId: string | undefined,
    @Query("deep") deep: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { user } = await requireUser(request, response, this.auth);
    if (!profileId) throw normalizedError("VALIDATION_FAILED", "Thiếu profileId", requestId(response));
    const trimmedPexelsAccountId = pexelsAccountId?.trim();
    const trimmedCreatomateAccountId = creatomateAccountId?.trim();
    const result = await this.capabilities.preflight(profileId, user.id, user.role, {
      ...(trimmedPexelsAccountId ? { pexelsAccountId: trimmedPexelsAccountId } : {}),
      ...(trimmedCreatomateAccountId ? { creatomateAccountId: trimmedCreatomateAccountId } : {}),
      deep: deep === "1" || deep === "true",
    });
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy automation profile", requestId(response), 404);
    return success(result, requestId(response));
  }
}
