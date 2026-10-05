import { Inject, Injectable } from "@nestjs/common";
import type { ProjectSummary } from "@lyonix/contracts";
import { canAccessProject, canManageProject } from "@lyonix/domain";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";

const toSummary = (row: { id: string; name: string; description: string | null; archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date }): ProjectSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  async list(userId: string, role: "admin" | "staff") {
    const grants = await this.grants.forUser(userId, role);
    const rows = await this.prisma.project.findMany({
      where: role === "admin" ? {} : { id: { in: grants.projectIds } },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toSummary);
  }

  async get(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) return null;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, row.id)) return null;
    return toSummary(row);
  }

  async create(name: string, description: string | undefined, actorId: string, actorRole: "admin" | "staff") {
    if (!canManageProject(actorRole)) return "forbidden" as const;
    const trimmed = name.trim();
    if (!trimmed) return "invalid" as const;
    const row = await this.prisma.project.create({
      data: { name: trimmed, description: description?.trim() || null, createdByUserId: actorId },
    });
    await this.grants.replaceProjectGrants(row.id, [], [actorId]);
    return toSummary(row);
  }

  async update(id: string, userId: string, role: "admin" | "staff", expectedVersion: number, input: { name?: string; description?: string | null; archived?: boolean }) {
    if (!canManageProject(role)) return "forbidden" as const;
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) return null;
    if (row.version !== expectedVersion) return "conflict" as const;
    const name = input.name === undefined ? row.name : input.name.trim();
    if (!name) return "invalid" as const;
    const result = await this.prisma.project.updateMany({
      where: { id, version: expectedVersion },
      data: {
        name,
        ...(input.description === undefined ? {} : { description: input.description?.trim() || null }),
        ...(input.archived === undefined ? {} : { archivedAt: input.archived ? new Date() : null }),
        version: { increment: 1 },
      },
    });
    if (!result.count) return "conflict" as const;
    const updated = await this.prisma.project.findUnique({ where: { id } });
    return updated ? toSummary(updated) : null;
  }

  async replaceGrants(id: string, userId: string, role: "admin" | "staff", expectedVersion: number, teamIds: string[], userIds: string[]) {
    if (!canManageProject(role)) return "forbidden" as const;
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) return null;
    if (row.version !== expectedVersion) return "conflict" as const;
    await this.grants.replaceProjectGrants(id, teamIds, userIds);
    const updated = await this.prisma.project.update({ where: { id }, data: { version: { increment: 1 } } });
    return toSummary(updated);
  }
}
