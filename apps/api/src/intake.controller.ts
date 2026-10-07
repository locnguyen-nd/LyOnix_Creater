import { Body, Controller, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { classifyIntakeUrl } from "@lyonix/domain";
import type { UiLocale, UrlIntakeRequest, UrlIntakeRewriteRequest, UrlIntakeStreamEvent } from "@lyonix/contracts";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { IntakeService } from "./intake.service.js";
import { IntakeRewriteService } from "./intake-rewrite.service.js";

const LOCALES: readonly string[] = ["vi", "en", "ja", "ko"];
const MAX_REWRITE_SOURCE_CHARS = 20_000;

const accountId = (value: unknown) => (typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : null);

/** Optional fields shared by the routes: content account, script language, narration length, the form's media / voice accounts. */
const intakeOptions = (body: Record<string, unknown>) => ({
  ...(accountId(body.contentAccountId) ? { contentAccountId: accountId(body.contentAccountId)! } : {}),
  ...(accountId(body.mediaAccountId) ? { mediaAccountId: accountId(body.mediaAccountId)! } : {}),
  ...(accountId(body.voiceAccountId) ? { voiceAccountId: accountId(body.voiceAccountId)! } : {}),
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

  /** `POST /intake/url { url, rewrite?, contentAccountId?, language?, durationSec?, mediaAccountId?, voiceAccountId? }`. */
  @Post("intake/url")
  async analyzeUrl(@Body() body: Partial<UrlIntakeRequest> | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const raw = (body ?? {}) as Record<string, unknown>;
    const result = typeof raw.url === "string" ? await this.intake.analyze(user.id, user.role, { url: raw.url, rewrite: raw.rewrite === true, ...intakeOptions(raw) }) : null;
    if (!result) throw normalizedError("VALIDATION_FAILED", "URL không hợp lệ (chỉ nhận http/https)", requestId(response));
    return success(result, requestId(response));
  }

  /**
   * `POST /intake/url/stream` (same body): the same analysis, answered as NDJSON so the page shows real progress - one `stage` line when
   * reading the source / getting subtitles / speech-to-text starts, then one `result` line. Invalid URL / auth: a normal JSON error.
   */
  @Post("intake/url/stream")
  async analyzeUrlStream(@Body() body: Partial<UrlIntakeRequest> | undefined, @Req() request: Request, @Res() response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const raw = (body ?? {}) as Record<string, unknown>;
    if (typeof raw.url !== "string" || !classifyIntakeUrl(raw.url).ok) throw normalizedError("VALIDATION_FAILED", "URL không hợp lệ (chỉ nhận http/https)", requestId(response));
    response.status(200);
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    const send = (event: UrlIntakeStreamEvent) => response.write(`${JSON.stringify(event)}\n`);
    try {
      const result = await this.intake.analyze(user.id, user.role, { url: raw.url, rewrite: raw.rewrite === true, ...intakeOptions(raw) }, (stage) => send({ type: "stage", stage }));
      if (result) send({ type: "result", data: result });
      else send({ type: "error", error: { code: "VALIDATION_FAILED", message: "URL không hợp lệ (chỉ nhận http/https)" } });
    } catch {
      send({ type: "error", error: { code: "INTERNAL_ERROR", message: "Không phân tích được URL" } });
    }
    response.end();
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
    const { contentAccountId, language, durationSec } = intakeOptions(raw);
    const result = await this.rewriter.rewrite(user.id, user.role, {
      source: { sourceType: source.sourceType as "tiktok" | "article", sourceUrl: source.sourceUrl as string, title: text(source.title, 300), sourceName: text(source.sourceName, 120), cleanedText: source.cleanedText as string },
      ...(contentAccountId ? { contentAccountId } : {}),
      ...(language ? { language } : {}),
      ...(durationSec ? { durationSec } : {}),
    });
    return success(result, requestId(response));
  }
}
