import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { isTrendCategory, isTrendProviderId, isTrendStatus } from "@lyonix/domain";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { TrendRadarConfigService } from "./trend-radar-config.service.js";
import { TrendRadarService, type ClusterFilters } from "./trend-radar.service.js";

const BANDS = ["hot", "rising", "review", "low"];
const num = (value: string | undefined, min: number, max: number): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : undefined;
};

/**
 * VE2E-158 Trend Radar API. Every signed-in user (staff + admin) can see topics, run the job now, import a TikTok URL, analyse, take a topic
 * and hand it to the create-video page; only an admin changes the configuration or tests a source connection. Mutations need the CSRF token.
 */
@Controller("trend-radar")
export class TrendRadarController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TrendRadarService) private readonly radar: TrendRadarService,
    @Inject(TrendRadarConfigService) private readonly config: TrendRadarConfigService,
  ) {}

  private async mutating(request: Request, response: Response) {
    const session = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session.session);
    return session;
  }

  private async admin(request: Request, response: Response, mutation: boolean) {
    const session = await requireUser(request, response, this.auth);
    if (session.user.role !== "admin") throw normalizedError("FORBIDDEN", "Chỉ Admin được cấu hình Trend Radar", requestId(response), 403);
    if (mutation) requireCsrf(request, response, session.session);
    return session;
  }

  @Get("overview")
  async overview(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    return success(await this.radar.overview(), requestId(response));
  }

  @Get("clusters")
  async clusters(@Query() query: Record<string, string | undefined>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const filters: ClusterFilters = {};
    if (query.provider) {
      if (!isTrendProviderId(query.provider)) throw normalizedError("VALIDATION_FAILED", "Nguồn không hợp lệ", requestId(response));
      filters.provider = query.provider;
    }
    if (query.category) {
      if (!isTrendCategory(query.category)) throw normalizedError("VALIDATION_FAILED", "Danh mục không hợp lệ", requestId(response));
      filters.category = query.category;
    }
    if (query.status) {
      if (!isTrendStatus(query.status)) throw normalizedError("VALIDATION_FAILED", "Trạng thái không hợp lệ", requestId(response));
      filters.status = query.status;
    }
    if (query.band) {
      if (!BANDS.includes(query.band)) throw normalizedError("VALIDATION_FAILED", "Nhóm điểm không hợp lệ", requestId(response));
      filters.band = query.band;
    }
    const sinceHours = num(query.sinceHours, 1, 24 * 30);
    const minScore = num(query.minScore, 0, 100);
    const limit = num(query.limit, 1, 100);
    const offset = num(query.offset, 0, 10_000);
    if (sinceHours !== undefined) filters.sinceHours = sinceHours;
    if (minScore !== undefined) filters.minScore = minScore;
    if (limit !== undefined) filters.limit = limit;
    if (offset !== undefined) filters.offset = offset;
    if (query.q?.trim()) filters.q = query.q.trim().slice(0, 100);
    if (query.assigneeId) filters.assigneeId = query.assigneeId;
    if (query.saved === "1" || query.saved === "true") filters.saved = true;
    return success(await this.radar.listClusters(filters), requestId(response));
  }

  @Get("clusters/:id")
  async cluster(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const detail = await this.radar.clusterDetail(id);
    if (!detail) throw normalizedError("NOT_FOUND", "Không tìm thấy chủ đề", requestId(response), 404);
    return success(detail, requestId(response));
  }

  @Patch("clusters/:id")
  async update(@Param("id") id: string, @Body() body: { status?: unknown; saved?: unknown }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await this.mutating(request, response);
    const outcome = await this.radar.updateCluster(id, body ?? {}, user.id);
    if (outcome === "not_found") throw normalizedError("NOT_FOUND", "Không tìm thấy chủ đề", requestId(response), 404);
    if (outcome === "invalid") throw normalizedError("VALIDATION_FAILED", "Trạng thái / lưu không hợp lệ", requestId(response));
    return success(outcome, requestId(response));
  }

  @Post("clusters/:id/analyze")
  async analyze(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.mutating(request, response);
    const outcome = await this.radar.analyze(id);
    if (!outcome) throw normalizedError("NOT_FOUND", "Không tìm thấy chủ đề", requestId(response), 404);
    return success(outcome, requestId(response));
  }

  @Get("clusters/:id/duplicates")
  async duplicates(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const found = await this.radar.duplicates(id);
    if (!found) throw normalizedError("NOT_FOUND", "Không tìm thấy chủ đề", requestId(response), 404);
    return success(found, requestId(response));
  }

  @Put("clusters/:id/assignment")
  async assign(@Param("id") id: string, @Body() body: { userId?: unknown; angleIndex?: unknown; angleTitle?: unknown; remove?: unknown }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await this.mutating(request, response);
    const outcome = await this.radar.assign(id, body ?? {}, { id: user.id, role: user.role });
    if (outcome === "not_found") throw normalizedError("NOT_FOUND", "Không tìm thấy chủ đề", requestId(response), 404);
    if (outcome === "forbidden") throw normalizedError("FORBIDDEN", "Chỉ Admin được giao chủ đề cho người khác", requestId(response), 403);
    if (outcome === "invalid") throw normalizedError("VALIDATION_FAILED", "Nhân viên / góc khai thác không hợp lệ", requestId(response));
    return success(outcome, requestId(response));
  }

  @Post("clusters/:id/productions")
  async production(@Param("id") id: string, @Body() body: { kind?: unknown; productionId?: unknown; angleIndex?: unknown }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await this.mutating(request, response);
    const outcome = await this.radar.linkProduction(id, body ?? {}, user.id);
    if (outcome === "not_found") throw normalizedError("NOT_FOUND", "Không tìm thấy chủ đề", requestId(response), 404);
    if (outcome === "invalid") throw normalizedError("VALIDATION_FAILED", "Job video không hợp lệ", requestId(response));
    return success(outcome, requestId(response));
  }

  @Get("assignees")
  async assignees(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    return success(await this.radar.assignees(), requestId(response));
  }

  @Post("runs")
  async runNow(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await this.mutating(request, response);
    return success(await this.radar.requestRun("manual", user.id), requestId(response));
  }

  @Get("runs")
  async runs(@Query("limit") limit: string | undefined, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    return success(await this.radar.listRuns(num(limit, 1, 100) ?? 20), requestId(response));
  }

  @Get("runs/:id")
  async run(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const run = await this.radar.run(id);
    if (!run) throw normalizedError("NOT_FOUND", "Không tìm thấy lượt chạy", requestId(response), 404);
    return success(run, requestId(response));
  }

  @Post("import")
  async importUrl(@Body() body: { url?: unknown }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await this.mutating(request, response);
    const outcome = await this.radar.importUrl(body?.url, user.id);
    if ("error" in outcome) throw normalizedError("VALIDATION_FAILED", outcome.error, requestId(response));
    return success(outcome, requestId(response));
  }

  @Get("config")
  async getConfig(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    return success(await this.config.view(), requestId(response));
  }

  @Patch("config")
  async updateConfig(@Body() body: Record<string, unknown>, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await this.admin(request, response, true);
    const outcome = await this.config.update(body ?? {}, user.id);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response));
    return success(outcome.data, requestId(response));
  }

  @Post("sources/:provider/test")
  async testSource(@Param("provider") provider: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.admin(request, response, true);
    return success(await this.radar.testSource(provider), requestId(response));
  }
}
