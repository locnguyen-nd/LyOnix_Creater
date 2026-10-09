import type { NextFunction, Request, Response } from "express";
import { VOICE_CLONE_LIMITS } from "./voice-clone-limits.js";

const CLONE_PATH = /^\/api\/v1\/provider-accounts\/[^/]+\/elevenlabs\/voice-clones\/?$/;

const reject = (response: Response, status: number, code: string, message: string) => {
  response.status(status).setHeader("connection", "close").json({
    error: { code, message, details: [], retryable: false },
    meta: { requestId: String(response.locals.requestId ?? "") },
  });
};

/**
 * JSON body parser with a larger limit, mounted for the voice-clone route only (the app-wide parser keeps Express's small default,
 * so no other endpoint accepts a 30 MB body). It must be registered before Nest's own parser: that one skips a request whose body
 * is already parsed.
 */
export const voiceCloneBodyParser = (limitBytes: number = VOICE_CLONE_LIMITS.bodyLimitBytes) => (request: Request, response: Response, next: NextFunction): void => {
  if (request.method !== "POST" || !CLONE_PATH.test(request.path)) return next();
  if (!/^application\/json/i.test(request.headers["content-type"] ?? "")) return next();
  const tooLarge = () => reject(response, 413, "VALIDATION_FAILED", `Tổng dung lượng mẫu quá lớn (tối đa ${Math.floor(VOICE_CLONE_LIMITS.maxTotalBytes / 1024 / 1024)} MB)`);
  if (Number(request.headers["content-length"] ?? 0) > limitBytes) return tooLarge();

  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  request.on("data", (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > limitBytes) {
      aborted = true;
      response.once("finish", () => request.destroy());
      tooLarge();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (aborted) return;
    try {
      const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const target = request as Request & { _body?: boolean };
      target.body = parsed;
      target._body = true;
      next();
    } catch {
      reject(response, 400, "VALIDATION_FAILED", "Nội dung yêu cầu không phải JSON hợp lệ");
    }
  });
  request.on("error", () => { if (!aborted) reject(response, 400, "VALIDATION_FAILED", "Không đọc được nội dung yêu cầu"); });
};
