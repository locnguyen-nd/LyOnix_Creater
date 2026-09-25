import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { success } from "./envelopes.js";

@Controller("health")
export class HealthController {
  @Get()
  getHealth(@Res({ passthrough: true }) response: Response) {
    return success({ status: "ok", service: "api" }, response.locals.requestId ?? "unknown");
  }
}
