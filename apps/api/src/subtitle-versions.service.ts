/**
 * V03-03: user editing of one voice's timed captions. Every save is a NEW `SubtitleVersion` (`source: "manual_edit"`, version + 1)
 * and the previous `current` one flips to `stale` - nothing is edited in place, so a timeline that pinned the old version keeps
 * rendering it until the user re-binds and re-approves. Optimistic concurrency like ScriptDraftVersion/TimelineVersion: the edit
 * must be based on the version that is current right now, else `VERSION_CONFLICT`.
 *
 * "Reset" rebuilds the automatic captions from the voice's stored ElevenLabs alignment with the same segmentation as the original
 * (`buildCaptionSegmentsFromAlignment`) - no provider call, no cost. Rules for an edit live in `@lyonix/domain/subtitle-edit`.
 */
import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@lyonix/db";
import { buildCaptionSegmentsFromAlignment, canAccessProject, validateSubtitleCues, type CharacterAlignment, type SubtitleCueError } from "@lyonix/domain";
import type { CaptionSegmentResponse, ErrorCode, ErrorDetail, SubtitleVersionResponse, SubtitleVersionSource } from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";

export type SubtitleVersionOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; details?: ErrorDetail[] };

type SubtitleRow = { id: string; audioVersionId: string; version: number; status: string; source: string; segments: unknown; staleReason: string | null; createdAt: Date };

const toResponse = (row: SubtitleRow): SubtitleVersionResponse => ({
  id: row.id,
  audioVersionId: row.audioVersionId,
  version: row.version,
  status: row.status as SubtitleVersionResponse["status"],
  source: row.source,
  segments: (Array.isArray(row.segments) ? row.segments : []) as CaptionSegmentResponse[],
  staleReason: row.staleReason,
  createdAt: row.createdAt.toISOString(),
});

const CUE_ERROR_MESSAGES: Record<SubtitleCueError["code"], string> = {
  NO_CUES: "Phụ đề phải có ít nhất một dòng",
  TOO_MANY_CUES: "Quá nhiều dòng phụ đề",
  NOT_INTEGER: "Thời điểm phải là số mili giây nguyên",
  TEXT_EMPTY: "Dòng phụ đề không được để trống",
  TEXT_TOO_LONG: "Dòng phụ đề quá dài",
  OUT_OF_RANGE: "Thời điểm nằm ngoài độ dài giọng đọc",
  TOO_SHORT: "Dòng phụ đề quá ngắn",
  OVERLAP: "Dòng phụ đề chồng lên dòng trước",
};

const conflict = (): SubtitleVersionOutcome<never> => ({ ok: false, code: "VERSION_CONFLICT", message: "Phụ đề đã được sửa ở nơi khác. Tải lại rồi thử lại.", status: 409 });

@Injectable()
export class SubtitleVersionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  private async loadAudio(audioVersionId: string, userId: string, role: "admin" | "staff"): Promise<SubtitleVersionOutcome<{ id: string; status: string; durationMs: number; alignment: unknown }>> {
    const audio = await this.prisma.audioVersion.findUnique({
      where: { id: audioVersionId },
      select: { id: true, status: true, durationMs: true, alignment: true, sceneDraftVersion: { select: { scriptDraftVersion: { select: { sourceVersion: { select: { projectId: true } } } } } } },
    });
    if (!audio) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy giọng đọc", status: 404 };
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, audio.sceneDraftVersion.scriptDraftVersion.sourceVersion.projectId)) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy giọng đọc", status: 404 };
    return { ok: true, data: audio };
  }

  async list(audioVersionId: string, userId: string, role: "admin" | "staff"): Promise<SubtitleVersionOutcome<SubtitleVersionResponse[]>> {
    const audio = await this.loadAudio(audioVersionId, userId, role);
    if (!audio.ok) return audio;
    const rows = await this.prisma.subtitleVersion.findMany({ where: { audioVersionId }, orderBy: { version: "desc" } });
    return { ok: true, data: rows.map(toResponse) };
  }

  async saveEdit(audioVersionId: string, userId: string, role: "admin" | "staff", input: { basedOnSubtitleVersionId?: unknown; cues?: unknown }): Promise<SubtitleVersionOutcome<SubtitleVersionResponse>> {
    const audio = await this.loadAudio(audioVersionId, userId, role);
    if (!audio.ok) return audio;
    const validation = validateSubtitleCues(input.cues, audio.data.durationMs);
    if (!validation.ok) {
      const first = validation.errors[0]!;
      return {
        ok: false,
        code: "VALIDATION_FAILED",
        message: first.index >= 0 ? `Dòng ${first.index + 1}: ${CUE_ERROR_MESSAGES[first.code]}` : CUE_ERROR_MESSAGES[first.code],
        status: 400,
        details: validation.errors.map((error) => ({ field: error.index >= 0 ? `cues[${error.index}]` : "cues", code: error.code })),
      };
    }
    return this.createVersion(audio.data, input.basedOnSubtitleVersionId, validation.cues, "manual_edit", userId);
  }

  async resetToAuto(audioVersionId: string, userId: string, role: "admin" | "staff", input: { basedOnSubtitleVersionId?: unknown }): Promise<SubtitleVersionOutcome<SubtitleVersionResponse>> {
    const audio = await this.loadAudio(audioVersionId, userId, role);
    if (!audio.ok) return audio;
    const segments = buildCaptionSegmentsFromAlignment(audio.data.alignment as CharacterAlignment);
    if (segments.length === 0) return { ok: false, code: "VALIDATION_FAILED", message: "Giọng đọc này không có dữ liệu căn thời gian để tạo lại phụ đề", status: 400 };
    return this.createVersion(audio.data, input.basedOnSubtitleVersionId, segments, "elevenlabs_alignment", userId);
  }

  private async createVersion(
    audio: { id: string; status: string },
    basedOn: unknown,
    segments: CaptionSegmentResponse[],
    source: SubtitleVersionSource,
    userId: string,
  ): Promise<SubtitleVersionOutcome<SubtitleVersionResponse>> {
    if (typeof basedOn !== "string" || !basedOn) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu basedOnSubtitleVersionId", status: 400 };
    if (audio.status !== "current") return { ok: false, code: "INVALID_STATE", message: "Giọng đọc này đã cũ; hãy sửa phụ đề của giọng đọc mới nhất", status: 409 };
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const current = await tx.subtitleVersion.findFirst({ where: { audioVersionId: audio.id, status: "current" }, orderBy: { version: "desc" } });
        if (!current || current.id !== basedOn) return null;
        // Compare-and-set: only one concurrent save may retire the version it was based on.
        const retired = await tx.subtitleVersion.updateMany({
          where: { id: current.id, status: "current" },
          data: { status: "stale", staleAt: new Date(), staleReason: source === "manual_edit" ? "edited" : "reset" },
        });
        if (retired.count !== 1) return null;
        const latest = await tx.subtitleVersion.findFirst({ where: { audioVersionId: audio.id }, orderBy: { version: "desc" }, select: { version: true } });
        return tx.subtitleVersion.create({
          data: { audioVersionId: audio.id, version: (latest?.version ?? 0) + 1, status: "current", source, segments: segments as unknown as Prisma.InputJsonValue, createdByUserId: userId },
        });
      });
      return created ? { ok: true, data: toResponse(created) } : conflict();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return conflict();
      throw error;
    }
  }
}
