/**
 * VE2E-124: the signed-in user's own defaults for the new-job form. Options only (mode, language, accounts, voice, template,
 * targets ...), never job content - the whitelist (`@lyonix/domain` creation-form) drops topic/prompt/scripts/URL even when sent.
 * Read only by the new-job page when it opens; existing jobs, ScriptPage and Studio never read them. No provider call, no cost.
 * Strictly per user (keyed by the session's userId). A default channel must still be accessible to the user when it is saved
 * (and the page checks it again every time it applies it).
 */
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import { sanitizeCreationPreferences } from "@lyonix/domain";
import type { CreationPreferencesResponse, ErrorCode } from "@lyonix/contracts";
import { canAccessChannel } from "./grant-access.js";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";

export type PreferencesOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

const toResponse = (row: { options: unknown; version: number; updatedAt: Date }): CreationPreferencesResponse => ({
  options: sanitizeCreationPreferences(row.options),
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class CreationPreferencesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  async get(userId: string): Promise<PreferencesOutcome<CreationPreferencesResponse | null>> {
    const row = await this.prisma.userCreationPreference.findUnique({ where: { userId } });
    return { ok: true, data: row ? toResponse(row) : null };
  }

  async save(userId: string, role: "admin" | "staff", input: { options?: unknown }): Promise<PreferencesOutcome<CreationPreferencesResponse>> {
    const options = sanitizeCreationPreferences(input.options);
    if (options.channelId) {
      const grants = await this.grants.forUser(userId, role);
      if (!canAccessChannel(role, grants, options.channelId)) return { ok: false, code: "FORBIDDEN", message: "Bạn không có quyền với kênh này nên không thể lưu làm mặc định", status: 403 };
    }
    const json = options as Prisma.InputJsonValue;
    const row = await this.prisma.userCreationPreference.upsert({
      where: { userId },
      create: { userId, options: json },
      update: { options: json, version: { increment: 1 } },
    });
    return { ok: true, data: toResponse(row) };
  }

  /** Back to the system defaults. Idempotent. */
  async reset(userId: string): Promise<PreferencesOutcome<{ reset: true }>> {
    await this.prisma.userCreationPreference.deleteMany({ where: { userId } });
    return { ok: true, data: { reset: true } };
  }
}
