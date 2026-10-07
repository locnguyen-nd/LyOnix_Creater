import { Body, Controller, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { UiLocale, UrlIntakeRequest, UrlIntakeRewriteRequest } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { IntakeService } from "./intake.service.js";
import { IntakeRewriteService } from "./intake-rewrite.service.js";

const LOCALES: readonly string[] = ["vi", "en", "ja", "ko"];
const MAX_REWRITE_SOURCE_CHARS = 20_000;

/** Optional fields shared by both routes: content account, script language, narration length. */
const rewriteOptions = (body: Record<string, unknown>) => ({
  ...(typeof body.contentAccountId === "string" && body.contentAccountId.trim() && body.contentAccountId.length <= 200 ? { contentAccountId: body.contentAccountId.trim() } : {}),
  ...(typeof body.language === "string" && LOCALES.includes(body.language) ? { language: body.language as UiLocale } : {}),
  ...(typeof body.durationSec === "number" && Number.isFinite(body.durationSec) && body.durationSec > 0 ? { durationSec: body.durationSec } : {}),
});

/** VE2E-96: the create-video page's URL intake (read-only: nothing is created or stored). */
@Controller()
export class IntakeController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(IntakeService) private readonly intake: IntakeService,
    @Inject(IntakeRewriteService) private readonly rewriter: IntakeRewriteService,
  ) {}

  /** `POST /intake/url { url, rewrite?, contentAccountId?, language?, durationSec? }`. */
  @Post("intake/url")
  async analyzeUrl(@Body() body: Partial<UrlIntakeRequest> | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const raw = (body ?? {}) as Record<string, unknown>;
    const result = typeof raw.url === "string" ? await this.intake.analyze(user.id, user.role, { url: raw.url, rewrite: raw.rewrite === true, ...rewriteOptions(raw) }) : null;
    if (!result) throw normalizedError("VALIDATION_FAILED", "URL không hợp lệ (chỉ nhận http/https)", requestId(response));
    return success(result, requestId(response));
  }

  /** `POST /intake/rewrite { source, contentAccountId?, language?, durationSec? }` - a new script from an already analysed source. */
  @Post("intake/rewrite")
  async rewrite(@Body() body: Partial<UrlIntakeRewriteRequest> | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const raw = (body ?? {}) as Record<string, unknown>;
    const source = raw.source && typeof raw.source === "object" ? (raw.source as Record<string, unknown>) : null;
    const valid =
      source &&
      (source.sourceType === "tiktok" || source.sourceType === "article") &&
      typeof source.sourceUrl === "string" && source.sourceUrl.length <= 2_000 &&
      typeof source.cleanedText === "string" && source.cleanedText.trim() && source.cleanedText.length <= MAX_REWRITE_SOURCE_CHARS;
    if (!valid) throw normalizedError("VALIDATION_FAILED", "Nguồn để viết lại không hợp lệ", requestId(response));
    const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
    const result = await this.rewriter.rewrite(user.id, user.role, {
      source: { sourceType: source.sourceType as "tiktok" | "article", sourceUrl: source.sourceUrl as string, title: text(source.title, 300), sourceName: text(source.sourceName, 120), cleanedText: source.cleanedText as string },
      ...rewriteOptions(raw),
    });
    return success(result, requestId(response));
  }
}
