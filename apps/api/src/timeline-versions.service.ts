/**
 * VE2E-07: persisted Studio `TimelineVersion` - the "API-backed timeline" this task adds
 * on top of the client-only localStorage scaffold from VE2E-07a. Save is optimistic
 * (`supersedesId` must match the project's actual latest version or the request is
 * rejected with `VERSION_CONFLICT`, the same pattern already used by `ScriptDraftVersion`/
 * `AudioVersion`). Approving a version is the only way to make it eligible for render
 * submission (`RenderJobsService.submitFromTimelineVersion`).
 */
import { Inject, Injectable } from "@nestjs/common";
import { canAccessProject } from "@lyonix/domain";
import type {
  ErrorCode,
  SaveTimelineVersionRequest,
  TemplateModificationSlotResponse,
  TimelineOptionValues,
  TimelineRenderPreviewResponse,
  TimelineSceneBindingInput,
  TimelineSceneBindingResponse,
  TimelineVersionResponse,
} from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { buildRenderAssignmentsFromTimeline, resolveSceneBindingsForMapping } from "./timeline-render-mapping.js";

export type TimelineOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

const MAX_SCENES = 60;
const MAX_TEXT_OVERRIDE_LENGTH = 2000;
const MAX_ANNOTATION_LENGTH = 2000;
const MAX_OPTION_VALUE_LENGTH = 2000;

export const toTimelineVersionResponse = (row: {
  id: string; projectId: string; version: number; status: string; templateSnapshotId: string | null;
  scenes: unknown; optionValues: unknown; supersedesId: string | null; createdAt: Date; approvedAt: Date | null;
}): TimelineVersionResponse => ({
  id: row.id,
  projectId: row.projectId,
  version: row.version,
  status: row.status as TimelineVersionResponse["status"],
  templateSnapshotId: row.templateSnapshotId,
  scenes: (Array.isArray(row.scenes) ? row.scenes : []) as TimelineSceneBindingResponse[],
  optionValues: (row.optionValues && typeof row.optionValues === "object" ? row.optionValues : {}) as TimelineOptionValues,
  supersedesId: row.supersedesId,
  createdAt: row.createdAt.toISOString(),
  approvedAt: row.approvedAt?.toISOString() ?? null,
});

@Injectable()
export class TimelineVersionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  private async assertProjectAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return false;
    const grants = await this.grants.forUser(userId, role);
    return canAccessProject(role, grants, projectId);
  }

  async list(projectId: string, userId: string, role: "admin" | "staff"): Promise<TimelineOutcome<TimelineVersionResponse[]>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const rows = await this.prisma.timelineVersion.findMany({ where: { projectId }, orderBy: { version: "desc" } });
    return { ok: true, data: rows.map(toTimelineVersionResponse) };
  }

  async latest(projectId: string, userId: string, role: "admin" | "staff"): Promise<TimelineOutcome<TimelineVersionResponse | null>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const row = await this.prisma.timelineVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
    return { ok: true, data: row ? toTimelineVersionResponse(row) : null };
  }

  async get(id: string, userId: string, role: "admin" | "staff"): Promise<TimelineOutcome<TimelineVersionResponse>> {
    const row = await this.prisma.timelineVersion.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (!(await this.assertProjectAccess(row.projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    return { ok: true, data: toTimelineVersionResponse(row) };
  }

  private async validateScenes(projectId: string, scenes: TimelineSceneBindingInput[]): Promise<TimelineOutcome<TimelineSceneBindingResponse[]>> {
    if (!Array.isArray(scenes) || scenes.length === 0) return { ok: false, code: "VALIDATION_FAILED", message: "Timeline cần ít nhất một scene" };
    if (scenes.length > MAX_SCENES) return { ok: false, code: "VALIDATION_FAILED", message: `Timeline vượt quá ${MAX_SCENES} scene` };
    const seen = new Set<string>();
    for (const scene of scenes) {
      const sceneId = scene.sceneId?.trim();
      if (!sceneId) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu sceneId cho một scene trong timeline" };
      if (seen.has(sceneId)) return { ok: false, code: "VALIDATION_FAILED", message: `sceneId trùng lặp trong timeline: ${sceneId}` };
      seen.add(sceneId);
      if (scene.screenTextOverride && scene.screenTextOverride.length > MAX_TEXT_OVERRIDE_LENGTH) {
        return { ok: false, code: "VALIDATION_FAILED", message: `screenTextOverride quá dài cho scene ${sceneId}` };
      }
      if (scene.annotation && scene.annotation.length > MAX_ANNOTATION_LENGTH) {
        return { ok: false, code: "VALIDATION_FAILED", message: `annotation quá dài cho scene ${sceneId}` };
      }
    }
    const mediaIds = [...new Set(scenes.map((s) => s.mediaAssetVersionId).filter((id): id is string => Boolean(id)))];
    if (mediaIds.length > 0) {
      const rows = await this.prisma.mediaAssetVersion.findMany({ where: { id: { in: mediaIds }, projectId, deletedAt: null }, select: { id: true } });
      const found = new Set(rows.map((r) => r.id));
      const missing = mediaIds.find((id) => !found.has(id));
      if (missing) return { ok: false, code: "NOT_FOUND", message: `Media asset không thuộc project này: ${missing}`, status: 404 };
    }
    const audioIds = [...new Set(scenes.map((s) => s.audioVersionId).filter((id): id is string => Boolean(id)))];
    if (audioIds.length > 0) {
      const rows = await this.prisma.audioVersion.findMany({
        where: { id: { in: audioIds } },
        select: { id: true, sceneDraftVersion: { select: { scriptDraftVersion: { select: { sourceVersion: { select: { projectId: true } } } } } } },
      });
      const validIds = new Set(rows.filter((r) => r.sceneDraftVersion.scriptDraftVersion.sourceVersion.projectId === projectId).map((r) => r.id));
      const missing = audioIds.find((id) => !validIds.has(id));
      if (missing) return { ok: false, code: "NOT_FOUND", message: `Audio version không thuộc project này: ${missing}`, status: 404 };
    }
    const subtitleIds = [...new Set(scenes.map((s) => s.subtitleVersionId).filter((id): id is string => Boolean(id)))];
    if (subtitleIds.length > 0) {
      const rows = await this.prisma.subtitleVersion.findMany({
        where: { id: { in: subtitleIds } },
        select: { id: true, audioVersion: { select: { sceneDraftVersion: { select: { scriptDraftVersion: { select: { sourceVersion: { select: { projectId: true } } } } } } } } },
      });
      const validIds = new Set(rows.filter((r) => r.audioVersion.sceneDraftVersion.scriptDraftVersion.sourceVersion.projectId === projectId).map((r) => r.id));
      const missing = subtitleIds.find((id) => !validIds.has(id));
      if (missing) return { ok: false, code: "NOT_FOUND", message: `Subtitle version không thuộc project này: ${missing}`, status: 404 };
    }
    return {
      ok: true,
      data: scenes.map((scene, index) => ({
        sceneId: scene.sceneId.trim(),
        orderIndex: index,
        mediaAssetVersionId: scene.mediaAssetVersionId ?? null,
        audioVersionId: scene.audioVersionId ?? null,
        subtitleVersionId: scene.subtitleVersionId ?? null,
        screenTextOverride: scene.screenTextOverride?.trim() || null,
        annotation: scene.annotation?.trim() || null,
      })),
    };
  }

  private async validateOptionValues(templateSnapshotId: string | null | undefined, optionValues: TimelineOptionValues): Promise<TimelineOutcome<TimelineOptionValues>> {
    const entries = Object.entries(optionValues ?? {});
    for (const [, value] of entries) {
      if (typeof value !== "string" || value.length > MAX_OPTION_VALUE_LENGTH) return { ok: false, code: "VALIDATION_FAILED", message: "Giá trị option không hợp lệ" };
    }
    if (entries.length === 0) return { ok: true, data: {} };
    if (!templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Cần chọn template trước khi đặt option values" };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: templateSnapshotId } });
    if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    const slots = Array.isArray(snapshot.modifications) ? (snapshot.modifications as unknown as TemplateModificationSlotResponse[]) : [];
    const keys = new Set(slots.map((slot) => slot.key));
    const unknownKey = entries.find(([key]) => !keys.has(key));
    if (unknownKey) return { ok: false, code: "VALIDATION_FAILED", message: `Option value không thuộc template: ${unknownKey[0]}` };
    return { ok: true, data: Object.fromEntries(entries) };
  }

  async save(projectId: string, userId: string, role: "admin" | "staff", input: SaveTimelineVersionRequest): Promise<TimelineOutcome<TimelineVersionResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    if (input.templateSnapshotId) {
      const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: input.templateSnapshotId } });
      if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    }
    const scenes = await this.validateScenes(projectId, input.scenes);
    if (!scenes.ok) return scenes;
    const optionValues = await this.validateOptionValues(input.templateSnapshotId, input.optionValues ?? {});
    if (!optionValues.ok) return optionValues;

    const latest = await this.prisma.timelineVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
    const expectedSupersedesId = latest?.id ?? null;
    if ((input.supersedesId ?? null) !== expectedSupersedesId) {
      return { ok: false, code: "VERSION_CONFLICT", message: "Timeline đã có phiên bản mới hơn từ khi bạn tải. Tải lại rồi lưu lại.", status: 409 };
    }
    const created = await this.prisma.timelineVersion.create({
      data: {
        projectId,
        version: (latest?.version ?? 0) + 1,
        status: "draft",
        templateSnapshotId: input.templateSnapshotId ?? null,
        scenes: scenes.data as unknown as object,
        optionValues: optionValues.data as unknown as object,
        supersedesId: expectedSupersedesId,
        createdByUserId: userId,
      },
    });
    return { ok: true, data: toTimelineVersionResponse(created) };
  }

  async approve(id: string, userId: string, role: "admin" | "staff"): Promise<TimelineOutcome<TimelineVersionResponse>> {
    const row = await this.prisma.timelineVersion.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (!(await this.assertProjectAccess(row.projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (row.status === "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline version đã được duyệt trước đó" };
    if (!row.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Cần chọn template trước khi duyệt timeline" };
    const latest = await this.prisma.timelineVersion.findFirst({ where: { projectId: row.projectId }, orderBy: { version: "desc" } });
    if (latest?.id !== id) return { ok: false, code: "VERSION_CONFLICT", message: "Timeline đã có phiên bản mới hơn. Tải lại trước khi duyệt.", status: 409 };
    const updated = await this.prisma.timelineVersion.updateMany({ where: { id, status: "draft" }, data: { status: "approved", approvedAt: new Date(), approvedByUserId: userId } });
    if (updated.count !== 1) return { ok: false, code: "INVALID_STATE", message: "Timeline version đã được duyệt trong một yêu cầu khác" };
    const approved = await this.prisma.timelineVersion.findUnique({ where: { id } });
    return { ok: true, data: toTimelineVersionResponse(approved!) };
  }

  /** No-charge, no-provider-call dry run (spec §5/§7): reports which modification keys the current timeline would fill. */
  async preview(id: string, userId: string, role: "admin" | "staff"): Promise<TimelineOutcome<TimelineRenderPreviewResponse>> {
    const row = await this.prisma.timelineVersion.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (!(await this.assertProjectAccess(row.projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (!row.templateSnapshotId) return { ok: true, data: { ready: false, filledModificationKeys: [], missingRequiredModificationKeys: [] } };
    const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: row.templateSnapshotId } });
    if (!snapshot) return { ok: true, data: { ready: false, filledModificationKeys: [], missingRequiredModificationKeys: [] } };
    const slots = Array.isArray(snapshot.modifications) ? (snapshot.modifications as unknown as TemplateModificationSlotResponse[]) : [];
    const scenes = (Array.isArray(row.scenes) ? row.scenes : []) as TimelineSceneBindingResponse[];
    const resolved = await resolveSceneBindingsForMapping(this.prisma, row.projectId, scenes);
    const optionValues = (row.optionValues && typeof row.optionValues === "object" ? row.optionValues : {}) as TimelineOptionValues;
    const built = buildRenderAssignmentsFromTimeline(slots, resolved, optionValues);
    return { ok: true, data: { ready: built.missingRequiredModificationKeys.length === 0, filledModificationKeys: built.filledModificationKeys, missingRequiredModificationKeys: built.missingRequiredModificationKeys } };
  }
}
