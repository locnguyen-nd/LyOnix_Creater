/**
 * VE2E-03: persists `ScriptDraftV2` (generated ephemerally by VE2E-01's
 * `POST /sources/:id/script-drafts`) as an immutable-once-approved `ScriptDraftVersion`
 * + `SceneDraftVersion` rows tied to the `SourceVersion`. Approving a new version that
 * replaces a previously-approved one for the same source cascades an invalidation:
 * every `current` `AudioVersion`/`SubtitleVersion` generated against the old version's
 * scenes flips to `stale` (DEC-2026-09-24 / VE2E-VIDEO-PRODUCTION.md §4: "Sửa script đã
 * duyệt tạo version mới và invalidate audio/subtitle/timeline/render có liên quan").
 */
import { Inject, Injectable } from "@nestjs/common";
import { canAccessProject } from "@lyonix/domain";
import type {
  ErrorCode,
  ScriptDraftSceneV2Response,
  ScriptDraftV2Response,
  ScriptDraftVersionResponse,
} from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";

export type ScriptVersionOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

type ProviderPinInput = {
  accountId: string; provider: string; modelId: string; configVersion: number; promptTemplateVersion: string;
  providerRequestId?: string | null;
  usage?: { inputTokens: number | null; outputTokens: number | null; costAmount: string | null; costCurrency: string | null };
  rankingVersion?: string;
  selectionReason?: "preferred_account" | "automatic_preference";
};

const toResponse = (row: {
  id: string; sourceVersionId: string; version: number; status: string; language: string; title: string; hook: string; body: string;
  cta: string; caption: string; providerPin: unknown; supersedesId: string | null; createdAt: Date; approvedAt: Date | null;
  scenes: { id: string; sceneId: string; orderIndex: number; narration: string; screenText: string; visualQuery: string; durationHintMs: number }[];
}): ScriptDraftVersionResponse => ({
  id: row.id,
  sourceVersionId: row.sourceVersionId,
  version: row.version,
  status: row.status as ScriptDraftVersionResponse["status"],
  language: row.language,
  title: row.title,
  hook: row.hook,
  body: row.body,
  cta: row.cta,
  caption: row.caption,
  providerPin: row.providerPin as ProviderPinInput,
  supersedesId: row.supersedesId,
  createdAt: row.createdAt.toISOString(),
  approvedAt: row.approvedAt?.toISOString() ?? null,
  scenes: [...row.scenes]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((scene) => ({
      id: scene.id,
      sceneId: scene.sceneId,
      orderIndex: scene.orderIndex,
      narration: scene.narration,
      screenText: scene.screenText,
      visualQuery: scene.visualQuery,
      durationHintMs: scene.durationHintMs,
    })),
});

@Injectable()
export class ScriptVersionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  private async assertSourceAccess(sourceVersionId: string, userId: string, role: "admin" | "staff") {
    const source = await this.prisma.sourceVersion.findUnique({ where: { id: sourceVersionId } });
    if (!source) return null;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, source.projectId)) return "forbidden" as const;
    return source;
  }

  async list(sourceVersionId: string, userId: string, role: "admin" | "staff"): Promise<ScriptVersionOutcome<ScriptDraftVersionResponse[]>> {
    const source = await this.assertSourceAccess(sourceVersionId, userId, role);
    if (!source) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy nguồn", status: 404 };
    if (source === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy nguồn", status: 404 };
    const rows = await this.prisma.scriptDraftVersion.findMany({
      where: { sourceVersionId },
      orderBy: { version: "desc" },
      include: { scenes: true },
    });
    return { ok: true, data: rows.map(toResponse) };
  }

  async get(id: string, userId: string, role: "admin" | "staff"): Promise<ScriptVersionOutcome<ScriptDraftVersionResponse>> {
    const row = await this.prisma.scriptDraftVersion.findUnique({ where: { id }, include: { scenes: true } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy script version", status: 404 };
    const access = await this.assertSourceAccess(row.sourceVersionId, userId, role);
    if (!access || access === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy script version", status: 404 };
    return { ok: true, data: toResponse(row) };
  }

  /**
   * Persists a `ScriptDraftV2` (already generated via `POST /sources/:id/script-drafts`,
   * VE2E-01) as a new draft `ScriptDraftVersion` + its scenes. Does not call any
   * provider — this is a pure persistence step, callers pass the draft + providerPin
   * they already received.
   */
  async create(
    sourceVersionId: string,
    userId: string,
    role: "admin" | "staff",
    input: { draft: ScriptDraftV2Response; providerPin: ProviderPinInput },
  ): Promise<ScriptVersionOutcome<ScriptDraftVersionResponse>> {
    const source = await this.assertSourceAccess(sourceVersionId, userId, role);
    if (!source) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy nguồn", status: 404 };
    if (source === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy nguồn", status: 404 };
    const draft = input.draft;
    if (!draft || draft.schemaVersion !== "script-draft.v2" || !Array.isArray(draft.scenes) || draft.scenes.length === 0) {
      return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu hoặc sai định dạng ScriptDraftV2" };
    }
    const sceneIds = new Set(draft.scenes.map((scene: ScriptDraftSceneV2Response) => scene.sceneId));
    if (sceneIds.size !== draft.scenes.length) return { ok: false, code: "VALIDATION_FAILED", message: "sceneId trùng lặp trong scenes" };

    const latest = await this.prisma.scriptDraftVersion.findFirst({ where: { sourceVersionId }, orderBy: { version: "desc" } });
    const version = (latest?.version ?? 0) + 1;
    const created = await this.prisma.scriptDraftVersion.create({
      data: {
        sourceVersionId,
        version,
        status: "draft",
        schemaVersion: draft.schemaVersion,
        language: draft.language,
        title: draft.title,
        hook: draft.hook,
        body: draft.body,
        cta: draft.cta,
        caption: draft.caption,
        providerPin: input.providerPin as unknown as object,
        supersedesId: latest?.id ?? null,
        createdByUserId: userId,
        scenes: {
          create: draft.scenes.map((scene: ScriptDraftSceneV2Response, index: number) => ({
            sceneId: scene.sceneId,
            orderIndex: index,
            narration: scene.narration,
            screenText: scene.screenText,
            visualQuery: scene.visualQuery,
            durationHintMs: scene.durationHintMs,
          })),
        },
      },
      include: { scenes: true },
    });
    return { ok: true, data: toResponse(created) };
  }

  /**
   * Approves a draft `ScriptDraftVersion`. If it replaces a previously-approved version
   * for the same source, cascades invalidation: every `current` `AudioVersion` (and its
   * `current` `SubtitleVersion`) generated against the *old* approved version's scenes
   * flips to `stale`. Media/timeline/render invalidation (scene image/video reassignment)
   * is untouched here — that stays VE2E-06/07 scope, and is not driven by TTS at all per
   * spec §4 ("thay một asset chỉ invalidate timeline/render, không gọi lại TTS").
   */
  async approve(id: string, userId: string, role: "admin" | "staff"): Promise<ScriptVersionOutcome<ScriptDraftVersionResponse>> {
    const row = await this.prisma.scriptDraftVersion.findUnique({ where: { id }, include: { scenes: true } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy script version", status: 404 };
    const access = await this.assertSourceAccess(row.sourceVersionId, userId, role);
    if (!access || access === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy script version", status: 404 };
    if (row.status === "approved") return { ok: false, code: "INVALID_STATE", message: "Script version đã được duyệt trước đó" };

    const approved = await this.prisma.$transaction(async (tx) => {
      const previousApproved = await tx.scriptDraftVersion.findFirst({
        where: { sourceVersionId: row.sourceVersionId, status: "approved", id: { not: id } },
        orderBy: { version: "desc" },
        include: { scenes: true },
      });
      // Conditional transition prevents two retries from both treating the same draft as newly approved.
      const transitioned = await tx.scriptDraftVersion.updateMany({
        where: { id, status: "draft" },
        data: { status: "approved", approvedAt: new Date() },
      });
      if (transitioned.count !== 1) return null;
      if (previousApproved) {
        const sceneIds = previousApproved.scenes.map((scene) => scene.id);
        if (sceneIds.length > 0) {
          const staleAudio = await tx.audioVersion.findMany({
            where: { sceneDraftVersionId: { in: sceneIds }, status: "current" },
          });
          if (staleAudio.length > 0) {
            const audioIds = staleAudio.map((audio) => audio.id);
            const staleAt = new Date();
            await tx.audioVersion.updateMany({
              where: { id: { in: audioIds }, status: "current" },
              data: { status: "stale", staleAt, staleReason: "script_revised" },
            });
            await tx.subtitleVersion.updateMany({
              where: { audioVersionId: { in: audioIds }, status: "current" },
              data: { status: "stale", staleAt, staleReason: "script_revised" },
            });
          }
        }
      }
      return tx.scriptDraftVersion.findUnique({ where: { id }, include: { scenes: true } });
    }, { isolationLevel: "Serializable" });
    if (!approved) return { ok: false, code: "INVALID_STATE", message: "Script version đã được duyệt trong một yêu cầu khác" };
    return { ok: true, data: toResponse(approved) };
  }
}
