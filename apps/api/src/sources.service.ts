import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { SourceType, SourceVersionSummary } from "@lyonix/contracts";
import { canAccessProject, validateSourceUrl } from "@lyonix/domain";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { extractArticleText } from "./source-extract.js";

export type CreateSourceInput =
  | { type: "topic"; topic: string }
  | { type: "raw_script"; rawScript: string }
  | { type: "article_url"; url: string }
  | { type: "file"; originalFileName: string; mimeType: string; checksumSha256: string };

const MAX_RAW_TEXT_CHARS = 20000;

const toSummary = (row: {
  id: string; projectId: string; type: string; version: number; originRef: string | null;
  fetchStatus: string; fetchError: string | null; checksumSha256: string | null; createdAt: Date; approvedAt: Date | null;
}): SourceVersionSummary => ({
  id: row.id,
  projectId: row.projectId,
  type: row.type as SourceType,
  version: row.version,
  originRef: row.originRef,
  fetchStatus: row.fetchStatus as SourceVersionSummary["fetchStatus"],
  fetchError: row.fetchError,
  checksumSha256: row.checksumSha256,
  createdAt: row.createdAt.toISOString(),
  approvedAt: row.approvedAt?.toISOString() ?? null,
});

@Injectable()
export class SourcesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  private async assertAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return null;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, projectId)) return null;
    return project;
  }

  async list(projectId: string, userId: string, role: "admin" | "staff") {
    if (!(await this.assertAccess(projectId, userId, role))) return "forbidden" as const;
    const rows = await this.prisma.sourceVersion.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
    return rows.map(toSummary);
  }

  async get(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.sourceVersion.findUnique({ where: { id } });
    if (!row) return null;
    if (!(await this.assertAccess(row.projectId, userId, role))) return "forbidden" as const;
    return toSummary(row);
  }

  /** Full row (with extractedText/originRef) for VE2E-01 script generation, after access check. */
  async getRowForGeneration(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.sourceVersion.findUnique({ where: { id } });
    if (!row) return null;
    if (!(await this.assertAccess(row.projectId, userId, role))) return "forbidden" as const;
    return row;
  }

  /**
   * VE2E-01: deferred fetch/extract step for `article_url` sources (VE2E-00 only validates
   * and records provenance at creation time; it never performs outbound HTTP in that request
   * handler). Idempotent — a source already `extracted` is returned unchanged.
   */
  async extractArticle(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.sourceVersion.findUnique({ where: { id } });
    if (!row) return null;
    if (!(await this.assertAccess(row.projectId, userId, role))) return "forbidden" as const;
    if (row.type !== "article_url") return "invalid_type" as const;
    if (row.fetchStatus === "extracted") return toSummary(row);
    if (!row.originRef) return "invalid_type" as const;
    const result = await extractArticleText(row.originRef);
    if (!result.ok) {
      const updated = await this.prisma.sourceVersion.update({
        where: { id },
        data: { fetchStatus: result.reason === "ssrf_blocked" ? "blocked" : "failed", fetchError: result.reason },
      });
      return { summary: toSummary(updated), extractFailed: result.reason };
    }
    const checksumSha256 = createHash("sha256").update(result.extractedText).digest("hex");
    const updated = await this.prisma.sourceVersion.update({
      where: { id },
      data: { fetchStatus: "extracted", extractedText: result.extractedText, checksumSha256, fetchError: null },
    });
    return toSummary(updated);
  }

  async create(projectId: string, userId: string, role: "admin" | "staff", input: CreateSourceInput) {
    if (!(await this.assertAccess(projectId, userId, role))) return "forbidden" as const;
    switch (input.type) {
      case "topic": {
        const topic = input.topic.trim();
        if (!topic || topic.length > 400) return "invalid" as const;
        return this.persist(projectId, userId, "topic", { originRef: null, rawText: topic, fetchStatus: "extracted", extractedText: topic });
      }
      case "raw_script": {
        const rawScript = input.rawScript.trim();
        if (!rawScript || rawScript.length > MAX_RAW_TEXT_CHARS) return "invalid" as const;
        return this.persist(projectId, userId, "raw_script", { originRef: null, rawText: rawScript, fetchStatus: "extracted", extractedText: rawScript });
      }
      case "article_url": {
        const check = validateSourceUrl(input.url);
        if (!check.ok) return "ssrf_blocked" as const;
        // Fetch/extract of the article body is a network-bound worker step (VE2E-01 content
        // adapters). This service only validates and records provenance; it never performs
        // outbound HTTP from the API request handler.
        return this.persist(projectId, userId, "article_url", { originRef: input.url, rawText: null, fetchStatus: "pending", extractedText: null });
      }
      case "file": {
        if (!input.originalFileName.trim() || !input.mimeType.trim() || !/^[0-9a-f]{64}$/i.test(input.checksumSha256)) return "invalid" as const;
        return this.persist(projectId, userId, "file", {
          originRef: input.originalFileName.trim(),
          rawText: null,
          fetchStatus: "fetched",
          extractedText: null,
          checksumSha256: input.checksumSha256.toLowerCase(),
        });
      }
      default:
        return "invalid" as const;
    }
  }

  private async persist(
    projectId: string,
    userId: string,
    type: "topic" | "raw_script" | "article_url" | "file",
    fields: { originRef: string | null; rawText: string | null; fetchStatus: "pending" | "fetched" | "extracted"; extractedText: string | null; checksumSha256?: string },
  ) {
    const checksumSha256 = fields.checksumSha256 ?? (fields.rawText ? createHash("sha256").update(fields.rawText).digest("hex") : null);
    const row = await this.prisma.sourceVersion.create({
      data: {
        projectId,
        type,
        version: 1,
        originRef: fields.originRef,
        rawText: fields.rawText,
        extractedText: fields.extractedText,
        checksumSha256,
        fetchStatus: fields.fetchStatus,
        createdByUserId: userId,
      },
    });
    return toSummary(row);
  }
}
