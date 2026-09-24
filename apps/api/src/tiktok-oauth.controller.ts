import { Body, Controller, Get, Inject, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { ChannelsService } from "./channels.service.js";
import { normalizedError, success } from "./envelopes.js";
import { TiktokOauthService } from "./tiktok-oauth.service.js";

@Controller()
export class TiktokOauthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TiktokOauthService) private readonly oauth: TiktokOauthService,
    @Inject(ChannelsService) private readonly channels: ChannelsService,
  ) {}

  @Get("channel-oauth/tiktok/setup")
  async setup(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    if (user.role !== "admin") throw normalizedError("FORBIDDEN", "Chỉ Admin được kết nối kênh TikTok", requestId(response), 403);
    return success(this.oauth.publicConfig(), requestId(response));
  }

  @Get("channel-oauth/tiktok/start")
  async start(@Req() request: Request, @Res() response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    if (user.role !== "admin") throw normalizedError("FORBIDDEN", "Chỉ Admin được kết nối kênh TikTok", requestId(response), 403);
    const url = this.oauth.begin(user.id);
    if (!url) return response.redirect(this.channels.uiRedirect({ error: "oauth_unconfigured" }));
    return response.redirect(url);
  }

  @Get("channel-oauth/tiktok/callback")
  async callback(@Query("code") code: string | undefined, @Query("state") state: string | undefined, @Query("error") error: string | undefined, @Res() response: Response) {
    if (error || !code || !state) return response.redirect(this.channels.uiRedirect({ error: "oauth_denied" }));
    const connection = await this.oauth.complete(code, state);
    if (!connection) return response.redirect(this.channels.uiRedirect({ error: "oauth_failed" }));
    return response.redirect(this.channels.uiRedirect({ connected: connection.channelId }));
  }

  @Post("channel-oauth/tiktok/complete")
  async complete(@Body() body: { code?: string; state?: string }, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (user.role !== "admin") throw normalizedError("FORBIDDEN", "Chỉ Admin được kết nối kênh TikTok", requestId(response), 403);
    if (!body.code || !body.state) throw normalizedError("WEBHOOK_INVALID", "TikTok callback không hợp lệ", requestId(response), 400);
    const connection = await this.oauth.complete(body.code, body.state);
    if (!connection) throw normalizedError("PROVIDER_UNAVAILABLE", "TikTok authorization thất bại hoặc redirect_uri không khớp", requestId(response), 502);
    return success({ channelId: connection.channelId, openId: connection.openId, scopes: connection.scopes }, requestId(response));
  }
}
