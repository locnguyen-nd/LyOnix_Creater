import { Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { NEWS_LIMITS, isNewsFilter } from "@lyonix/domain";
import { requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { NewsService } from "./news.service.js";

/** VE2E-96: `GET /news?filter=all|yahoo_jp|japan|sports|entertainment|trending&q=` - headlines for the create-video page (signed-in users). */
@Controller()
export class NewsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(NewsService) private readonly news: NewsService) {}

  @Get("news")
  async feed(@Query("filter") filter: string | undefined, @Query("q") q: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const chosen = filter?.trim() || "all";
    if (!isNewsFilter(chosen)) throw normalizedError("VALIDATION_FAILED", "Bộ lọc tin không hợp lệ", requestId(response));
    if (typeof q === "string" && q.length > NEWS_LIMITS.maxQueryChars * 4) throw normalizedError("VALIDATION_FAILED", "Từ khoá tìm kiếm quá dài", requestId(response));
    return success(await this.news.feed({ filter: chosen, query: typeof q === "string" ? q : "" }), requestId(response));
  }
}
