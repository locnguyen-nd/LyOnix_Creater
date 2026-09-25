import { Controller, Get, Header, Headers, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { MediaDeliveryService } from "./media-delivery.service.js";

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

@Controller()
export class MediaDeliveryController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(MediaDeliveryService) private readonly delivery: MediaDeliveryService) {}

  @Post("media-assets/:id/delivery-tokens")
  async issue(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const result = await this.delivery.issueToken(id, user.id, user.role);
    if (result === "not_configured") throw normalizedError("PROVIDER_NOT_CONFIGURED", "PUBLIC_BASE_URL chưa cấu hình trên server", requestId(response), 503);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy asset", requestId(response), 404);
    if (result === "forbidden") throw normalizedError("NOT_FOUND", "Không tìm thấy asset", requestId(response), 404);
    return success(result, requestId(response));
  }

  @Get("media-delivery/:token")
  @Header("Cache-Control", "private, no-store")
  async deliver(@Param("token") token: string, @Headers("range") range: string | undefined, @Res() response: Response) {
    const resolved = await this.delivery.resolve(token);
    if (!resolved) {
      response.status(404).json({ error: { code: "NOT_FOUND", message: "Token không hợp lệ hoặc đã hết hạn", details: [], retryable: false }, meta: { requestId: response.locals.requestId ?? "unknown" } });
      return;
    }
    const info = await stat(resolved.absolutePath);
    const safeName = resolved.originalFileName.replace(/[^\w.\- ]/g, "_");
    response.setHeader("Content-Type", resolved.mimeType);
    response.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    response.setHeader("Accept-Ranges", "bytes");
    const match = range ? RANGE_RE.exec(range) : null;
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : info.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= info.size) {
        response.status(416).setHeader("Content-Range", `bytes */${info.size}`).end();
        return;
      }
      response.status(206);
      response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
      response.setHeader("Content-Length", String(end - start + 1));
      createReadStream(resolved.absolutePath, { start, end }).pipe(response);
      return;
    }
    response.setHeader("Content-Length", String(info.size));
    createReadStream(resolved.absolutePath).pipe(response);
  }
}
