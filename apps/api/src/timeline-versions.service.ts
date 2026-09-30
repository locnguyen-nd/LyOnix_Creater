/**
 * VE2E-07: persisted Studio `TimelineVersion` - the "API-backed timeline" this task adds
 * on top of the client-only localStorage scaffold from VE2E-07a. Save is optimistic
 * (`supersedesId` must match the project's actual latest version or the request is
 * rejected with `VERSION_CONFLICT`, the same pattern already used by `ScriptDraftVersion`/
 * `AudioVersion`). Approving a version is the only way to make it eligible for render
 * submission (`RenderJobsService.submitFromTimelineVersion`).
 *
 * VE2E-42 (CR-JP-ONESHOT-MEDIA-2026-09-29 §8): the shared timeline contract gains optional
 * background `segments` and per-scene source ranges (`segmentId`/`sourceStartMs`/
 * `sourceDurationMs`), validated here for both Studio saves and the Auto runner
 * (`persistApprovedForWorkflowRun`). All of it is optional: a timeline without them validates
 * and renders exactly as before.
 */
import { Inject, Injectable } from "@nestjs/common";
import { canAccessProject, validateTimelineSegmentStructure } from "@lyonix/domain";
import { isDynamicStyleOptionKey, isValidDynamicStyleOptionValue } from "@lyonix/providers";
import type {
  ErrorCode,
  SaveTimelineVersionRequest,
  TemplateModificationSlotResponse,
  TimelineOptionValues,
  TimelineRenderPreviewResponse,
  TimelineSceneBindingInput,
  TimelineSceneBindingResponse,
  TimelineSegmentInput,
  TimelineSegmentResponse,
  TimelineVersionResponse,
} from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { buildRenderAssignmentsFromTimeline, resolveSceneBindingsForMapping } from "./timeline-render-mapping.js";

export type TimelineOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

const MAX_SCENES = 60;
const MAX_SEGMENTS = MAX_SCENES;
const MAX_TEXT_OVERRIDE_LENGTH = 2000;
const MAX_ANNOTATION_LENGTH = 2000;
const MAX_OPTION_VALUE_LENGTH = 2000;

const nullableInt = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Reads one stored scene binding. Every field added after the row may have been written is
 * defaulted, so a legacy row reads back exactly as it rendered then: `excluded` -> false and the
 * VE2E-42 `segmentId`/`sourceStartMs`/`sourceDurationMs` -> null (= no segment, no range).
 */
export const toTimelineSceneBindingResponse = (scene: Partial<TimelineSceneBindingResponse> & { sceneId: string; orderIndex: number }): TimelineSceneBindingResponse => ({
  ...scene,
  mediaAssetVersionId: scene.mediaAssetVersionId ?? null,
  audioVersionId: scene.audioVersionId ?? null,
  subtitleVersionId: scene.subtitleVersionId ?? null,
  screenTextOverride: scene.screenTextOverride ?? null,
  annotation: scene.annotation ?? null,
  excluded: Boolean(scene.excluded),
  segmentId: typeof scene.segmentId === "string" && scene.segmentId ? scene.segmentId : null,
  sourceStartMs: nullableInt(scene.sourceStartMs),
  sourceDurationMs: nullableInt(scene.sourceDurationMs),
});

const toTimelineSegmentResponse = (segment: Partial<TimelineSegmentResponse>): TimelineSegmentResponse => ({
  segmentId: String(segment.segmentId ?? ""),
  sceneIds: Array.isArray(segment.sceneIds) ? segment.sceneIds.map(String) : [],
  mediaAssetVersionId: segment.mediaAssetVersionId ?? null,
  subject: segment.subject ?? null,
  priority: nullableInt(segment.priority),
});

export const toTimelineVersionResponse = (row: {
  id: string; projectId: string; version: number; status: string; templateSnapshotId: string | null;
  scenes: unknown; optionValues: unknown; supersedesId: string | null; createdAt: Date; approvedAt: Date | null;
  segments?: unknown; workflowRunId?: string | null;
}): TimelineVersionResponse => ({
  id: row.id,
  projectId: row.projectId,
  version: row.version,
  status: row.status as TimelineVersionResponse["status"],
  templateSnapshotId: row.templateSnapshotId,
  scenes: ((Array.isArray(row.scenes) ? row.scenes : []) as TimelineSceneBindingResponse[]).map(toTimelineSceneBindingResponse),
  optionValues: (row.optionValues && typeof row.optionValues === "object" ? row.optionValues : {}) as TimelineOptionValues,
  segments: ((Array.isArray(row.segments) ? row.segments : []) as TimelineSegmentResponse[]).map(toTimelineSegmentResponse),
  supersedesId: row.supersedesId,
  workflowRunId: row.workflowRunId ?? null,
  createdAt: row.createdAt.toISOString(),
  approvedAt: row.approvedAt?.toISOString() ?? null,
});

/** Validated, normalized content of one timeline version - what `save` and `persistApprovedForWorkflowRun` both write. */
type ValidatedTimelineContent = {
  scenes: TimelineSceneBindingResponse[];
  segments: TimelineSegmentResponse[];
  optionValues: TimelineOptionValues;
};

/** Input of the trusted Auto runner path (never exposed over HTTP). */
export type WorkflowRunTimelineInput = {
  templateSnapshotId: string;
  scenes: TimelineSceneBindingInput[];
  optionValues?: TimelineOptionValues;
  segments?: TimelineSegmentInput[];
};

/** Key-order-independent JSON for content equality (JSONB does not preserve object key order). */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

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

  private async validateScenes(
    projectId: string,
    scenes: TimelineSceneBindingInput[],
    segmentsInput: TimelineSegmentInput[] | undefined,
  ): Promise<TimelineOutcome<{ scenes: TimelineSceneBindingResponse[]; segments: TimelineSegmentResponse[] }>> {
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

    // VE2E-42: optional segments + per-scene source ranges - pure structural rules first (no DB).
    if (segmentsInput !== undefined && segmentsInput !== null && !Array.isArray(segmentsInput)) return { ok: false, code: "VALIDATION_FAILED", message: "segments phải là mảng" };
    const segmentList = segmentsInput ?? [];
    if (segmentList.length > MAX_SEGMENTS) return { ok: false, code: "VALIDATION_FAILED", message: `Timeline vượt quá ${MAX_SEGMENTS} segment` };
    const trimmedScenes = scenes.map((scene) => ({ ...scene, sceneId: scene.sceneId.trim() }));
    const structure = validateTimelineSegmentStructure(trimmedScenes, segmentList);
    if (!structure.ok) return { ok: false, code: "VALIDATION_FAILED", message: structure.message };

    const mediaIds = [
      ...new Set(
        [...trimmedScenes.map((s) => s.mediaAssetVersionId), ...segmentList.map((segment) => segment.mediaAssetVersionId)].filter((id): id is string => Boolean(id)),
      ),
    ];
    if (mediaIds.length > 0) {
      const rows = await this.prisma.mediaAssetVersion.findMany({ where: { id: { in: mediaIds }, projectId, deletedAt: null }, select: { id: true, kind: true, durationMs: true } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const missing = mediaIds.find((id) => !byId.has(id));
      if (missing) return { ok: false, code: "NOT_FOUND", message: `Media asset không thuộc project này: ${missing}`, status: 404 };
      for (const scene of trimmedScenes) {
        if (scene.sourceStartMs == null || scene.sourceDurationMs == null || !scene.mediaAssetVersionId) continue;
        const media = byId.get(scene.mediaAssetVersionId)!;
        // A range is a slice of a source video's own timeline; an image has none.
        if (media.kind !== "video") return { ok: false, code: "VALIDATION_FAILED", message: `Scene ${scene.sceneId}: dải nguồn chỉ áp dụng cho media video` };
        // Only enforceable when the source duration is known (some older imports have none).
        if (media.durationMs != null && scene.sourceStartMs + scene.sourceDurationMs > media.durationMs) {
          return { ok: false, code: "VALIDATION_FAILED", message: `Scene ${scene.sceneId}: dải nguồn vượt quá thời lượng media` };
        }
      }
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
      data: {
        scenes: trimmedScenes.map((scene, index) => ({
          sceneId: scene.sceneId,
          orderIndex: index,
          mediaAssetVersionId: scene.mediaAssetVersionId ?? null,
          audioVersionId: scene.audioVersionId ?? null,
          subtitleVersionId: scene.subtitleVersionId ?? null,
          screenTextOverride: scene.screenTextOverride?.trim() || null,
          annotation: scene.annotation?.trim() || null,
          excluded: Boolean(scene.excluded),
          segmentId: scene.segmentId?.trim() || null,
          sourceStartMs: scene.sourceStartMs ?? null,
          sourceDurationMs: scene.sourceDurationMs ?? null,
        })),
        segments: segmentList.map((segment) => ({
          segmentId: segment.segmentId.trim(),
          sceneIds: [...segment.sceneIds],
          mediaAssetVersionId: segment.mediaAssetVersionId ?? null,
          subject: segment.subject?.trim() || null,
          priority: segment.priority ?? null,
        })),
      },
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
    // VE2E-26: `dynamicStyle.*` keys are a separate, fixed whitelist of Studio style
    // overrides for the dynamic-composition render path (see `applyDynamicStyleOverrides` in
    // @lyonix/providers) - never a real template modification key (those always look like
    // `<ElementName>.<property>`), so they are validated against their own value rules
    // instead of the template's modification-slot key set.
    const invalidEntry = entries.find(([key, value]) => (isDynamicStyleOptionKey(key) ? !isValidDynamicStyleOptionValue(key, value) : !keys.has(key)));
    if (invalidEntry) return { ok: false, code: "VALIDATION_FAILED", message: `Option value không hợp lệ: ${invalidEntry[0]}` };
    return { ok: true, data: Object.fromEntries(entries) };
  }

  /** One validation path shared by `save` (Studio) and `persistApprovedForWorkflowRun` (Auto), so both flows produce the same contract. */
  /**
   * VE2E-44: persist the default `[0, min(voice, asset)]` range on every video scene that has none, so
   * an approved timeline (and what Studio shows/renders from it) never sends a whole 50-100MB source.
   * Scenes that already carry a range, images, unknown durations and short assets are returned as-is.
   */
  private async withDefaultVideoRanges(projectId: string, scenes: TimelineSceneBindingResponse[]): Promise<TimelineSceneBindingResponse[]> {
    const resolved = await resolveSceneBindingsForMapping(this.prisma, projectId, scenes, { fillDefaultVideoRanges: true });
    const byId = new Map(resolved.map((scene) => [scene.sceneId, scene]));
    return scenes.map((scene) => {
      const filled = byId.get(scene.sceneId);
      if (!filled || scene.sourceStartMs != null || scene.sourceDurationMs != null) return scene;
      if (typeof filled.sourceStartMs !== "number" || typeof filled.sourceDurationMs !== "number") return scene;
      return { ...scene, sourceStartMs: filled.sourceStartMs, sourceDurationMs: filled.sourceDurationMs };
    });
  }

  private async validateContent(
    projectId: string,
    input: { templateSnapshotId?: string | null; scenes: TimelineSceneBindingInput[]; optionValues?: TimelineOptionValues; segments?: TimelineSegmentInput[] },
  ): Promise<TimelineOutcome<ValidatedTimelineContent>> {
    if (input.templateSnapshotId) {
      const snapshot = await this.prisma.templateSnapshot.findUnique({ where: { id: input.templateSnapshotId } });
      if (!snapshot) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy template snapshot", status: 404 };
    }
    const scenes = await this.validateScenes(projectId, input.scenes, input.segments);
    if (!scenes.ok) return scenes;
    const optionValues = await this.validateOptionValues(input.templateSnapshotId, input.optionValues ?? {});
    if (!optionValues.ok) return optionValues;
    return { ok: true, data: { scenes: scenes.data.scenes, segments: scenes.data.segments, optionValues: optionValues.data } };
  }

  async save(projectId: string, userId: string, role: "admin" | "staff", input: SaveTimelineVersionRequest): Promise<TimelineOutcome<TimelineVersionResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const content = await this.validateContent(projectId, input);
    if (!content.ok) return content;

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
        scenes: content.data.scenes as unknown as object,
        optionValues: content.data.optionValues as unknown as object,
        segments: content.data.segments as unknown as object,
        supersedesId: expectedSupersedesId,
        createdByUserId: userId,
      },
    });
    return { ok: true, data: toTimelineVersionResponse(created) };
  }

  /**
   * VE2E-42: the Auto runner's zero-human-gate equivalent of `save` + `approve`
   * (CR-JP-ONESHOT-MEDIA-2026-09-29 §8: "Auto lưu + tự duyệt TimelineVersion"), so "Mở trong
   * Studio" on an Auto run shows exactly what was rendered. Not exposed over HTTP - only
   * `WorkflowRunnerService` calls it, acting as the run's creator (the same actor it already
   * uses to auto-approve the script). Validates through the exact same path as a Studio save,
   * then writes the version already `approved` and tagged with `workflowRunId` (audit), superseding
   * whatever the project's latest version is.
   *
   * Idempotent across a run retry: when the project's latest version was written by this same
   * run with identical content, that version is returned instead of stacking a duplicate.
   */
  async persistApprovedForWorkflowRun(
    workflowRunId: string,
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: WorkflowRunTimelineInput,
  ): Promise<TimelineOutcome<TimelineVersionResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    if (!input.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Cần chọn template trước khi duyệt timeline" };
    const content = await this.validateContent(projectId, input);
    if (!content.ok) return content;
    content.data.scenes = await this.withDefaultVideoRanges(projectId, content.data.scenes);

    const latest = await this.prisma.timelineVersion.findFirst({ where: { projectId }, orderBy: { version: "desc" } });
    if (latest && latest.workflowRunId === workflowRunId && latest.status === "approved" && latest.templateSnapshotId === input.templateSnapshotId) {
      const existing = toTimelineVersionResponse(latest);
      if (
        stableJson(existing.scenes) === stableJson(content.data.scenes) &&
        stableJson(existing.segments) === stableJson(content.data.segments) &&
        stableJson(existing.optionValues) === stableJson(content.data.optionValues)
      ) {
        return { ok: true, data: existing };
      }
    }
    const now = new Date();
    try {
      const created = await this.prisma.timelineVersion.create({
        data: {
          projectId,
          version: (latest?.version ?? 0) + 1,
          status: "approved",
          templateSnapshotId: input.templateSnapshotId,
          scenes: content.data.scenes as unknown as object,
          optionValues: content.data.optionValues as unknown as object,
          segments: content.data.segments as unknown as object,
          supersedesId: latest?.id ?? null,
          createdByUserId: userId,
          approvedAt: now,
          approvedByUserId: userId,
          workflowRunId,
        },
      });
      return { ok: true, data: toTimelineVersionResponse(created) };
    } catch (error) {
      // Unique (projectId, version): a concurrent Studio save took the same version number.
      if (error && typeof error === "object" && (error as { code?: unknown }).code === "P2002") {
        return { ok: false, code: "VERSION_CONFLICT", message: "Timeline vừa được lưu bởi yêu cầu khác; chạy lại để lưu phiên bản mới", status: 409 };
      }
      throw error;
    }
  }

  async approve(id: string, userId: string, role: "admin" | "staff"): Promise<TimelineOutcome<TimelineVersionResponse>> {
    const row = await this.prisma.timelineVersion.findUnique({ where: { id } });
    if (!row) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (!(await this.assertProjectAccess(row.projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy timeline version", status: 404 };
    if (row.status === "approved") return { ok: false, code: "INVALID_STATE", message: "Timeline version đã được duyệt trước đó" };
    if (!row.templateSnapshotId) return { ok: false, code: "VALIDATION_FAILED", message: "Cần chọn template trước khi duyệt timeline" };
    const latest = await this.prisma.timelineVersion.findFirst({ where: { projectId: row.projectId }, orderBy: { version: "desc" } });
    if (latest?.id !== id) return { ok: false, code: "VERSION_CONFLICT", message: "Timeline đã có phiên bản mới hơn. Tải lại trước khi duyệt.", status: 409 };
    const storedScenes = (Array.isArray(row.scenes) ? row.scenes : []) as TimelineSceneBindingResponse[];
    const withRanges = await this.withDefaultVideoRanges(row.projectId, storedScenes);
    const rangesChanged = withRanges.some((scene, index) => scene !== storedScenes[index]);
    const updated = await this.prisma.timelineVersion.updateMany({
      where: { id, status: "draft" },
      data: { status: "approved", approvedAt: new Date(), approvedByUserId: userId, ...(rangesChanged ? { scenes: withRanges as unknown as object } : {}) },
    });
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
