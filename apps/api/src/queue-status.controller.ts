import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { success } from "./envelopes.js";
import { QueueStatusService } from "./queue-status.service.js";

@Controller()
export class QueueStatusController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(QueueStatusService) private readonly queue: QueueStatusService,
  ) {}

  /** VE2E-62: `[{kind, active, limit, queued}]` for workflow / render / media (global counts; any signed-in user). */
  @Get("queue-summary")
  async summary(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    return success(await this.queue.summary(), requestId(response));
  }
}
