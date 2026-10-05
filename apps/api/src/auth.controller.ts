import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service.js";
import { attachSessionTokens, clearAuthCookies, cookieValue, currentSession, requestId, requireCsrf, requireUser } from "./auth.helpers.js";
import { normalizedError, success } from "./envelopes.js";
import { verifyJwt } from "./jwt.js";
import { AuthRateLimiter } from "./auth-rate-limit.js";

type LoginBody = { email?: string; password?: string };
type RegisterBody = { email?: string; displayName?: string; password?: string };
type RefreshBody = { refreshToken?: string };
type PreferencesBody = { uiLocale?: "vi" | "en" | "ja" | "ko"; theme?: "light" | "dark" | "system"; timezone?: string };
type PasswordBody = { currentPassword?: string; newPassword?: string };

type CurrentUser = NonNullable<Awaited<ReturnType<AuthService["getUser"]>>>;
const me = (user: CurrentUser) => ({
  id: user.id, email: user.email, displayName: user.displayName, role: user.role, preferences: user.preferences, grants: user.grants, version: user.version,
});

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuthRateLimiter) private readonly rateLimiter: AuthRateLimiter,
  ) {}

  private async rateLimit(request: Request, response: Response, scope: "login" | "register", identifier: string) {
    const waitMs = await this.rateLimiter.consume(scope, request.ip ?? request.socket.remoteAddress ?? "unknown", identifier);
    if (waitMs !== null) {
      response.setHeader("Retry-After", String(Math.ceil(waitMs / 1000)));
      throw normalizedError("AUTH_RATE_LIMITED", "Quá nhiều lần thử. Vui lòng thử lại sau.", requestId(response), 429, [], true);
    }
  }

  @Post("auth/register")
  @HttpCode(201)
  async register(@Body() body: RegisterBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.rateLimit(request, response, "register", body.email ?? "");
    if (typeof body.email !== "string" || typeof body.displayName !== "string" || typeof body.password !== "string") {
      throw normalizedError("VALIDATION_FAILED", "Vui lòng nhập đầy đủ thông tin", requestId(response));
    }
    const result = await this.auth.register({ email: body.email, displayName: body.displayName, password: body.password });
    if (result === "invalid") throw normalizedError("VALIDATION_FAILED", "Email không hợp lệ; tên tối đa 100 ký tự và mật khẩu cần từ 8 ký tự", requestId(response));
    if (result === "duplicate") throw normalizedError("ACCOUNT_EMAIL_TAKEN", "Email đã được sử dụng", requestId(response), 409);
    return success({ status: "pending_approval" }, requestId(response));
  }

  @Post("auth/login")
  @HttpCode(200)
  async login(@Body() body: LoginBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.rateLimit(request, response, "login", body.email ?? "");
    const user = typeof body.email === "string" && typeof body.password === "string" ? await this.auth.authenticate(body.email, body.password) : null;
    if (!user) throw normalizedError("UNAUTHENTICATED", "Email hoặc mật khẩu không đúng", requestId(response), 401);
    if (user === "pending") throw normalizedError("ACCOUNT_PENDING_APPROVAL", "Tài khoản đang chờ Admin duyệt", requestId(response), 403);
    const session = await this.auth.createSession(user.id);
    const tokens = attachSessionTokens(response, session);
    return success({ ...me(user), tokenType: tokens.tokenType, expiresIn: tokens.expiresIn, accessToken: tokens.accessToken }, requestId(response));
  }

  @Post("auth/refresh")
  @HttpCode(200)
  async refresh(@Body() body: RefreshBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const raw = (typeof body.refreshToken === "string" && body.refreshToken.trim()) || cookieValue(request, "lyonix_refresh");
    const payload = verifyJwt(raw);
    if (!payload || payload.typ !== "refresh") throw normalizedError("UNAUTHENTICATED", "Refresh token không hợp lệ", requestId(response), 401);
    const session = await this.auth.getSession(payload.sid);
    if (!session || session.userId !== payload.sub) throw normalizedError("UNAUTHENTICATED", "Phiên đã hết hạn", requestId(response), 401);
    const tokens = attachSessionTokens(response, session);
    return success({ tokenType: tokens.tokenType, expiresIn: tokens.expiresIn, accessToken: tokens.accessToken }, requestId(response));
  }

  @Post("auth/logout")
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const session = await currentSession(request, this.auth);
    if (session) requireCsrf(request, response, session);
    await this.auth.revoke(session?.id);
    clearAuthCookies(response);
  }

  @Get("auth/csrf")
  async csrf(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session } = await requireUser(request, response, this.auth);
    return success({ csrfToken: session.csrfToken }, requestId(response));
  }

  @Get("me")
  async getMe(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return success(me((await requireUser(request, response, this.auth)).user), requestId(response));
  }

  @Patch("me/preferences")
  async preferences(@Body() body: PreferencesBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth); requireCsrf(request, response, session);
    if (!request.header("if-match")) throw normalizedError("VERSION_CONFLICT", "Thiếu If-Match", requestId(response), 412);
    if (body.uiLocale && !["vi", "en", "ja", "ko"].includes(body.uiLocale)) throw normalizedError("VALIDATION_FAILED", "Ngôn ngữ không hợp lệ", requestId(response));
    const updated = await this.auth.updatePreferences(user.id, body);
    return success(me(updated!), requestId(response));
  }

  @Post("me/change-password")
  @HttpCode(204)
  async changePassword(@Body() body: PasswordBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth); requireCsrf(request, response, session);
    if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") throw normalizedError("VALIDATION_FAILED", "Dữ liệu không hợp lệ", requestId(response));
    const result = await this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
    if (result === "invalid") throw normalizedError("UNAUTHENTICATED", "Mật khẩu hiện tại không đúng", requestId(response), 401);
    if (result === "weak") throw normalizedError("VALIDATION_FAILED", "Mật khẩu mới tối thiểu 8 ký tự", requestId(response));
    clearAuthCookies(response);
  }
}
