import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import { canAccessProject, canWriteProjectResource } from "@lyonix/domain";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";

export type AutomationProfileConfig = {
  name: string;
  projectId?: string | null;
  contentConfig: { providerAccountId: string };
  /** `voiceId` is optional and, when present, lets `GET /provider-capabilities/preflight?deep=1` target the exact ElevenLabs voice this profile pins instead of only checking account-level verification. Auto submit (VE2E-06) additionally requires `voiceId` to actually generate TTS — a profile without it can still be created (e.g. Studio-only) but is rejected at `POST /video-productions` time. */
  voiceConfig: { providerAccountId: string; voiceId?: string };
  mediaPolicy?: string;
  /** VE2E-06: Pexels account for the Auto media-preparing fallback (project library checked first). Required for an Auto submit, optional at profile-creation time (a Studio-only profile may omit it). */
  mediaConfig?: { providerAccountId: string } | null;
  /** VE2E-06: Creatomate account + pinned `TemplateSnapshot` for the Auto render step. Required for an Auto submit, optional at profile-creation time. */
  renderConfig?: { providerAccountId: string; templateSnapshotId: string; outputFormat?: "mp4" | "mov" | "gif" } | null;
  /** Legacy/unused by the VE2E-06 orchestrator (no code ever read this field before now — confirmed by repo-wide grep) — kept only for backward compatibility with rows/tests created before `mediaConfig`/`renderConfig` existed. */
  templateSnapshotRef?: string | null;
  brandOptions?: Record<string, unknown>;
  outputPreset: { aspectRatio: string; width: number; height: number; fps: number };
  locale?: string;
  durationSec: number;
  sceneCount: number;
  costCeiling: { amount: string; currency: string };
  retryPolicy?: Record<string, unknown>;
  accountFallbackAllowlist?: string[];
};

export type PublicAutomationProfile = {
  id: string;
  projectId: string | null;
  name: string;
  version: number;
  contentConfig: unknown;
  voiceConfig: unknown;
  mediaPolicy: string;
  mediaConfig: unknown;
  renderConfig: unknown;
  templateSnapshotRef: string | null;
  outputPreset: unknown;
  locale: string;
  durationSec: number;
  sceneCount: number;
  costCeiling: { amount: string; currency: string };
  retryPolicy: unknown;
  createdAt: string;
};

const toPublic = (row: {
  id: string; projectId: string | null; name: string; version: number; contentConfig: unknown; voiceConfig: unknown;
  mediaPolicy: string; mediaConfig: unknown; renderConfig: unknown; templateSnapshotRef: string | null; outputPreset: unknown; locale: string; durationSec: number;
  sceneCount: number; costCeilingAmount: { toString(): string }; costCeilingCurrency: string; retryPolicy: unknown; createdAt: Date;
}): PublicAutomationProfile => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  version: row.version,
  contentConfig: row.contentConfig,
  voiceConfig: row.voiceConfig,
  mediaPolicy: row.mediaPolicy,
  mediaConfig: row.mediaConfig,
  renderConfig: row.renderConfig,
  templateSnapshotRef: row.templateSnapshotRef,
  outputPreset: row.outputPreset,
  locale: row.locale,
  durationSec: row.durationSec,
  sceneCount: row.sceneCount,
  costCeiling: { amount: row.costCeilingAmount.toString(), currency: row.costCeilingCurrency },
  retryPolicy: row.retryPolicy,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class AutomationProfilesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  async list(userId: string, role: "admin" | "staff", projectId?: string) {
    if (projectId) {
      const grants = await this.grants.forUser(userId, role);
      if (!canAccessProject(role, grants, projectId)) return "forbidden" as const;
    }
    const rows = await this.prisma.automationProfileVersion.findMany({
      where: projectId ? { projectId } : {},
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toPublic);
  }

  async get(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.automationProfileVersion.findUnique({ where: { id } });
    if (!row) return null;
    if (row.projectId) {
      const grants = await this.grants.forUser(userId, role);
      if (!canAccessProject(role, grants, row.projectId)) return "forbidden" as const;
    }
    return toPublic(row);
  }

  async create(userId: string, role: "admin" | "staff", input: AutomationProfileConfig) {
    if (input.projectId) {
      const grants = await this.grants.forUser(userId, role);
      if (!canWriteProjectResource(role, grants, input.projectId)) return "forbidden" as const;
    }
    if (!input.name.trim() || !input.contentConfig?.providerAccountId || !input.voiceConfig?.providerAccountId) return "invalid" as const;
    if (input.durationSec <= 0 || input.sceneCount <= 0) return "invalid" as const;
    const row = await this.prisma.automationProfileVersion.create({
      data: {
        projectId: input.projectId ?? null,
        name: input.name.trim(),
        version: 1,
        contentConfig: input.contentConfig as Prisma.InputJsonValue,
        voiceConfig: input.voiceConfig as Prisma.InputJsonValue,
        mediaPolicy: input.mediaPolicy ?? "project_library_then_pexels",
        mediaConfig: (input.mediaConfig ?? null) as Prisma.InputJsonValue,
        renderConfig: (input.renderConfig ?? null) as Prisma.InputJsonValue,
        templateSnapshotRef: input.templateSnapshotRef ?? null,
        brandOptions: (input.brandOptions ?? {}) as Prisma.InputJsonValue,
        outputPreset: input.outputPreset as Prisma.InputJsonValue,
        locale: input.locale ?? "vi",
        durationSec: input.durationSec,
        sceneCount: input.sceneCount,
        costCeilingAmount: input.costCeiling.amount,
        costCeilingCurrency: input.costCeiling.currency,
        retryPolicy: (input.retryPolicy ?? {}) as Prisma.InputJsonValue,
        accountFallbackAllowlist: (input.accountFallbackAllowlist ?? []) as Prisma.InputJsonValue,
        createdByUserId: userId,
      },
    });
    return toPublic(row);
  }
}
