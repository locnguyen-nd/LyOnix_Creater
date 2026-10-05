import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Put, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { ProjectsService } from "./projects.service.js";

type CreateBody = { name?: string; description?: string };
type UpdateBody = { name?: string; description?: string | null; archived?: boolean };
type GrantsBody = { teamIds?: string[]; userIds?: string[] };

const expectedVersion = (raw: string | undefined) => {
  const match = raw?.trim().match(/^(?:W\/)?"?(\d+)"?$/);
  return match ? Number(match[1]) : null;
};

@Controller()
export class ProjectsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Get("projects")
  async list(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    return success(await this.projects.list(user.id, user.role), requestId(response));
  }

  @Get("projects/:id")
  async get(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user } = await requireUser(request, response, this.auth);
    const project = await this.projects.get(id, user.id, user.role);
    if (!project) throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    return success(project, requestId(response));
  }

  @Post("projects")
  async create(@Body() body: CreateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const project = await this.projects.create(body.name ?? "", body.description, user.id, user.role);
    if (project === "forbidden") throw normalizedError("FORBIDDEN", "Chỉ Admin được tạo dự án", requestId(response), 403);
    if (project === "invalid") throw normalizedError("VALIDATION_FAILED", "Tên dự án không được để trống", requestId(response));
    return success(project, requestId(response));
  }

  @Patch("projects/:id")
  async update(@Param("id") id: string, @Headers("if-match") ifMatch: string | undefined, @Body() body: UpdateBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const version = expectedVersion(ifMatch);
    if (version === null) throw normalizedError("VALIDATION_FAILED", "Thiếu If-Match phiên bản dự án", requestId(response));
    const project = await this.projects.update(id, user.id, user.role, version, body);
    if (!project) throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    if (project === "forbidden") throw normalizedError("FORBIDDEN", "Chỉ Admin được sửa dự án", requestId(response), 403);
    if (project === "conflict") throw normalizedError("VERSION_CONFLICT", "Dự án đã được cập nhật ở nơi khác. Hãy tải lại.", requestId(response), 409);
    if (project === "invalid") throw normalizedError("VALIDATION_FAILED", "Tên dự án không được để trống", requestId(response));
    response.setHeader("ETag", `"${project.version}"`);
    return success(project, requestId(response));
  }

  @Put("projects/:id/grants")
  async replaceGrants(@Param("id") id: string, @Headers("if-match") ifMatch: string | undefined, @Body() body: GrantsBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const version = expectedVersion(ifMatch);
    if (version === null) throw normalizedError("VALIDATION_FAILED", "Thiếu If-Match phiên bản dự án", requestId(response));
    const project = await this.projects.replaceGrants(id, user.id, user.role, version, body.teamIds ?? [], body.userIds ?? []);
    if (!project) throw normalizedError("NOT_FOUND", "Không tìm thấy dự án", requestId(response), 404);
    if (project === "forbidden") throw normalizedError("FORBIDDEN", "Chỉ Admin được đổi quyền dự án", requestId(response), 403);
    if (project === "conflict") throw normalizedError("VERSION_CONFLICT", "Dự án đã được cập nhật ở nơi khác. Hãy tải lại.", requestId(response), 409);
    response.setHeader("ETag", `"${project.version}"`);
    return success(project, requestId(response));
  }
}
