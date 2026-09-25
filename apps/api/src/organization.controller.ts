import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { GrantsService } from "./grants.service.js";

type TeamBody = { name?: string; memberIds?: string[]; channelIds?: string[] };
type UserBody = { email?: string; displayName?: string; role?: "admin" | "staff"; password?: string; disabled?: boolean; teamIds?: string[]; channelIds?: string[] };

@Controller()
export class OrganizationController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(GrantsService) private readonly grants: GrantsService) {}

  private async admin(request: Request, response: Response) {
    const session = await requireUser(request, response, this.auth);
    if (session.user.role !== "admin") throw normalizedError("FORBIDDEN", "Chỉ Admin được quản lý nhóm và người dùng", requestId(response), 403);
    return session;
  }

  @Get("organization/teams")
  async teams(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.admin(request, response);
    return success(await this.grants.listTeams(), requestId(response));
  }

  @Get("organization/users")
  async users(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.admin(request, response);
    return success(await this.grants.listUsers(), requestId(response));
  }

  @Post("organization/teams")
  async createTeam(@Body() body: TeamBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.admin(request, response);
    requireCsrf(request, response, session);
    if (!body.name?.trim()) throw normalizedError("VALIDATION_FAILED", "Thiếu tên nhóm", requestId(response));
    return success(await this.grants.upsertTeam({ name: body.name, memberIds: body.memberIds ?? [], channelIds: body.channelIds ?? [] }), requestId(response));
  }

  @Put("organization/teams/:id")
  async updateTeam(@Param("id") id: string, @Body() body: TeamBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.admin(request, response);
    requireCsrf(request, response, session);
    if (!body.name?.trim()) throw normalizedError("VALIDATION_FAILED", "Thiếu tên nhóm", requestId(response));
    return success(await this.grants.upsertTeam({ id, name: body.name, memberIds: body.memberIds ?? [], channelIds: body.channelIds ?? [] }), requestId(response));
  }

  @Delete("organization/teams/:id")
  async deleteTeam(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.admin(request, response);
    requireCsrf(request, response, session);
    const result = await this.grants.deleteTeam(id);
    if (result === "last") throw normalizedError("INVALID_STATE", "Cần ít nhất một nhóm", requestId(response), 409);
    return success({ id }, requestId(response));
  }

  @Post("organization/users")
  async createUser(@Body() body: UserBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.admin(request, response);
    requireCsrf(request, response, session);
    const user = await this.grants.createUser({
      email: body.email ?? "",
      displayName: body.displayName ?? "",
      role: body.role === "admin" ? "admin" : "staff",
      password: body.password ?? "",
      disabled: Boolean(body.disabled),
      teamIds: body.teamIds ?? [],
      channelIds: body.channelIds ?? [],
    });
    if (user === "invalid") throw normalizedError("VALIDATION_FAILED", "Thiếu email, tên hiển thị hoặc mật khẩu", requestId(response));
    if (user === "duplicate") throw normalizedError("VALIDATION_FAILED", "Email đã được sử dụng", requestId(response));
    return success(user, requestId(response));
  }

  @Put("organization/users/:id")
  async updateUser(@Param("id") id: string, @Body() body: UserBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.admin(request, response);
    requireCsrf(request, response, session);
    const user = await this.grants.updateUser(id, {
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.role === undefined ? {} : { role: body.role }),
      ...(body.disabled === undefined ? {} : { disabled: body.disabled }),
      ...(body.teamIds === undefined ? {} : { teamIds: body.teamIds }),
      ...(body.channelIds === undefined ? {} : { channelIds: body.channelIds }),
    });
    if (!user) throw normalizedError("NOT_FOUND", "Không tìm thấy người dùng", requestId(response), 404);
    return success(user, requestId(response));
  }

  @Post("organization/users/:id/approve")
  async approveUser(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session } = await this.admin(request, response);
    requireCsrf(request, response, session);
    const user = await this.grants.approveUser(id);
    if (!user) throw normalizedError("NOT_FOUND", "Không tìm thấy người dùng", requestId(response), 404);
    return success(user, requestId(response));
  }

  @Delete("organization/users/:id")
  async deleteUser(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { session, user } = await this.admin(request, response);
    requireCsrf(request, response, session);
    const result = await this.grants.deleteUser(id, user.id);
    if (result === "self") throw normalizedError("INVALID_STATE", "Không xóa chính mình", requestId(response), 409);
    if (!result) throw normalizedError("NOT_FOUND", "Không tìm thấy người dùng", requestId(response), 404);
    return success({ id }, requestId(response));
  }
}
