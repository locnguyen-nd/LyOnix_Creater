/**
 * VE2E-31 (CR-JP-ONESHOT-MEDIA-2026-09-29 §4/§8): the ONE server-side media selection for the
 * one-shot background plan, used by the Auto runner (`workflow-runner.service.ts`) and exposed to
 * Studio via `POST /projects/:projectId/media-plans` (VE2E-41 builds the UI on it; there is no
 * client-side copy of this logic).
 *
 * Flow: `planSegments` (pure, `@lyonix/domain/media-plan`) groups consecutive scenes into
 * background segments from the script's `visualPlan` or a deterministic fallback, sized by the
 * run's VE2E-40 segment-count range -> per segment, one source is found (`findReusableSource`,
 * else `importSegmentSource` through the existing Pexels search/rank/vision-moderation/rights
 * gate in `PexelsService.autoImportForScene`) -> `buildBindings` cuts contiguous per-scene
 * ranges from that source by real voice duration and emits TimelineVersion scene bindings +
 * segments (VE2E-42 contract).
 *
 * Reuse policy (replaces VE2E-15a's per-scene `usedExternalIds` hard block): every scene of a
 * segment shares the segment's single source; a NEW segment always needs a source not used by any
 * earlier segment of the same plan (external id and asset id both tracked). Rights/moderation
 * rules are unchanged - they run inside `autoImportForScene` once per segment source.
 *
 * No FFmpeg / clip cutting here: only ranges are written; derivative cutting at render is VE2E-37.
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  MAX_QUERY_VARIANTS,
  MEDIA_PLAN_POLICY_VERSION,
  canWriteProjectResource,
  computeSegmentSourceRanges,
  deriveSceneBrief,
  planBackgroundSegments,
  type MediaPlanScene,
  type PlannedSegment,
  type SceneBrief,
  type SceneSourceRange,
} from "@lyonix/domain";
import type {
  ErrorCode,
  MediaPlanResponse,
  MediaPlanSegmentDiagnostics,
  ScriptVisualPlanResponse,
  TimelineSceneBindingInput,
  TimelineSegmentInput,
} from "@lyonix/contracts";
import { normalizeScriptVisualPlanV2 } from "@lyonix/providers";
import { GrantsService } from "./grants.service.js";
import { PexelsService } from "./pexels.service.js";
import { PrismaService } from "./prisma.service.js";

export type MediaPlanOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number };

export type MediaPlanScriptScene = {
  sceneId: string;
  narration: string;
  screenText: string;
  visualQuery: string;
  durationHintMs: number;
  /** Real voice duration (AudioVersion.durationMs); `null` = no audio yet -> `durationHintMs` is used. */
  voiceDurationMs: number | null;
};

export type MediaPlanScript = {
  language: string;
  /** In script order. */
  scenes: MediaPlanScriptScene[];
  visualPlan: ScriptVisualPlanResponse | null;
};

export type SegmentSource = {
  mediaAssetVersionId: string;
  kind: "video" | "image";
  durationMs: number | null;
  /** Provider external id when known (used to keep later segments off this source). */
  externalId: string | null;
  sourcing: "reused" | "imported";
};

export type SourcedSegment = { segment: PlannedSegment; source: SegmentSource | null; errorCode: string | null };

/** Tracks what earlier segments of one plan already used - a new segment must never pick any of these. */
export class SegmentSourceLedger {
  readonly externalIds = new Set<string>();
  readonly assetIds = new Set<string>();
  add(source: SegmentSource) {
    this.assetIds.add(source.mediaAssetVersionId);
    if (source.externalId) this.externalIds.add(source.externalId);
  }
}

/** Pexels imports are registered as `pexels-<id>.<ext>` (pexels.service.ts `import`); that is the only place the external id survives on the asset row. */
export const pexelsExternalIdFromFileName = (fileName: string): string | null => /^pexels-(\d+)\./.exec(fileName)?.[1] ?? null;

const sceneDuration = (scene: MediaPlanScriptScene) => Math.max(1, Math.round(scene.voiceDurationMs ?? scene.durationHintMs));

@Injectable()
export class MediaPlanService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(PexelsService) private readonly pexels: PexelsService,
  ) {}

  planSegments(script: MediaPlanScript, range: { min: number; max: number } | null): PlannedSegment[] {
    const scenes: MediaPlanScene[] = script.scenes.map((scene) => ({ sceneId: scene.sceneId, durationMs: sceneDuration(scene) }));
    return planBackgroundSegments(scenes, script.visualPlan, range);
  }

  /**
   * Retry/Studio idempotency: an asset already assigned (by `MediaAssetVersion.sceneId`) to the
   * segment's first scene is reused instead of re-searching, unless an earlier segment already uses
   * that same source. Derivatives (VE2E-37 lineage rows) are never picked as a segment source.
   */
  async findReusableSource(projectId: string, segment: PlannedSegment, ledger: SegmentSourceLedger): Promise<SegmentSource | null> {
    const firstSceneId = segment.sceneIds[0];
    if (!firstSceneId) return null;
    const row = await this.prisma.mediaAssetVersion.findFirst({
      where: { projectId, sceneId: firstSceneId, deletedAt: null, parentMediaAssetVersionId: null },
      orderBy: { createdAt: "desc" },
    });
    if (!row || (row.kind !== "video" && row.kind !== "image")) return null;
    const externalId = pexelsExternalIdFromFileName(row.originalFileName);
    if (ledger.assetIds.has(row.id) || (externalId && ledger.externalIds.has(externalId))) return null;
    return { mediaAssetVersionId: row.id, kind: row.kind, durationMs: row.durationMs, externalId, sourcing: "reused" };
  }

  /**
   * The segment's search brief: the first scene's narrative-beat brief (VE2E-15a), led by the
   * segment's `keywords.en` when the plan has one (Pexels indexes English best; `keywords.ja` is kept
   * on the timeline segment for the future Apify source, VE2E-34), and targeting the WHOLE segment's
   * duration so ranking prefers clips long enough to run across all its scenes.
   */
  segmentBrief(script: MediaPlanScript, segment: PlannedSegment): SceneBrief {
    const firstIndex = Math.max(0, script.scenes.findIndex((scene) => scene.sceneId === segment.sceneIds[0]));
    const brief = deriveSceneBrief({ language: script.language, scenes: script.scenes.map((scene) => ({ ...scene, durationHintMs: sceneDuration(scene) })) }, firstIndex);
    const english = segment.keywords?.en.trim();
    const phrases = english ? [english, ...brief.phrases.filter((phrase) => phrase.trim().toLowerCase() !== english.toLowerCase())].slice(0, MAX_QUERY_VARIANTS) : brief.phrases;
    return { ...brief, phrases, targetDurationSeconds: segment.durationMs / 1000 };
  }

  /** Searches/ranks/moderates/imports one new source for the segment via the existing Pexels gate, excluding every source an earlier segment used. */
  async importSegmentSource(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; script: MediaPlanScript; segment: PlannedSegment; ledger: SegmentSourceLedger },
  ): Promise<MediaPlanOutcome<SegmentSource>> {
    const brief = this.segmentBrief(input.script, input.segment);
    const firstScene = input.script.scenes.find((scene) => scene.sceneId === input.segment.sceneIds[0]);
    const outcome = await this.pexels.autoImportForScene(projectId, userId, role, {
      providerAccountId: input.providerAccountId,
      sceneId: input.segment.sceneIds[0]!,
      query: brief.phrases[0] ?? firstScene?.visualQuery ?? "",
      sceneBrief: brief,
      usedExternalIds: [...input.ledger.externalIds],
    });
    if (!outcome.ok) return outcome;
    const asset = outcome.data.asset;
    if (asset.kind !== "video" && asset.kind !== "image") return { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: `Asset Pexels vừa import có kind không hỗ trợ: ${asset.kind}` };
    if (input.ledger.assetIds.has(asset.id)) {
      // Same bytes as an earlier segment's source (checksum dedupe in MediaService) - a new segment must use a different source.
      return { ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "Nguồn tìm được trùng với nguồn của segment trước; cần chọn thủ công trong Studio.", status: 422 };
    }
    return { ok: true, data: { mediaAssetVersionId: asset.id, kind: asset.kind, durationMs: asset.durationMs, externalId: outcome.data.externalId, sourcing: "imported" } };
  }

  /** Per-scene bindings + timeline segments for the sourced segments (a segment without a source leaves its scenes unbound). */
  buildBindings(script: MediaPlanScript, sourced: SourcedSegment[]): {
    scenes: Array<Required<Pick<TimelineSceneBindingInput, "sceneId">> & { mediaAssetVersionId: string | null; mediaKind: "video" | "image" | null; segmentId: string | null; sourceStartMs: number | null; sourceDurationMs: number | null }>;
    segments: TimelineSegmentInput[];
    diagnostics: MediaPlanSegmentDiagnostics[];
  } {
    const bySceneId = new Map<string, { segmentId: string; source: SegmentSource; range: SceneSourceRange | null }>();
    const segments: TimelineSegmentInput[] = [];
    const diagnostics: MediaPlanSegmentDiagnostics[] = [];
    for (const { segment, source, errorCode } of sourced) {
      let ranges: SceneSourceRange[] | null = null;
      if (source) {
        const sceneDurations = segment.sceneIds.map((sceneId) => {
          const scene = script.scenes.find((s) => s.sceneId === sceneId);
          return { sceneId, durationMs: scene ? sceneDuration(scene) : 1 };
        });
        ranges = source.kind === "video" ? computeSegmentSourceRanges(sceneDurations, source.durationMs) : null;
        for (const sceneId of segment.sceneIds) bySceneId.set(sceneId, { segmentId: segment.segmentId, source, range: ranges?.find((r) => r.sceneId === sceneId) ?? null });
        segments.push({ segmentId: segment.segmentId, sceneIds: [...segment.sceneIds], mediaAssetVersionId: source.mediaAssetVersionId, subject: segment.subject, priority: segment.priority });
      }
      diagnostics.push({
        segmentId: segment.segmentId,
        origin: segment.origin,
        sourcing: source ? source.sourcing : "failed",
        errorCode: source ? null : errorCode,
        durationMs: segment.durationMs,
        looped: Boolean(ranges?.some((r) => r.looped)),
        short: Boolean(ranges?.some((r) => r.short)),
      });
    }
    return {
      scenes: script.scenes.map((scene) => {
        const bound = bySceneId.get(scene.sceneId);
        return {
          sceneId: scene.sceneId,
          mediaAssetVersionId: bound?.source.mediaAssetVersionId ?? null,
          mediaKind: bound?.source.kind ?? null,
          segmentId: bound?.segmentId ?? null,
          sourceStartMs: bound?.range?.sourceStartMs ?? null,
          sourceDurationMs: bound?.range?.sourceDurationMs ?? null,
        };
      }),
      segments,
      diagnostics,
    };
  }

  /**
   * Studio entry (`POST /projects/:projectId/media-plans`): the same planning/sourcing as Auto for
   * one script version, returned without saving a TimelineVersion. Unlike Auto (which stops the run
   * on the first unsourceable segment, needs_input), a failed segment here is reported in
   * `diagnostics` and its scenes are left unbound so the user can pick manually.
   */
  async planForScriptVersion(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { scriptDraftVersionId: string; providerAccountId: string; range: (totalVoiceSeconds: number) => { min: number; max: number } | null },
  ): Promise<MediaPlanOutcome<MediaPlanResponse>> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const grants = await this.grants.forUser(userId, role);
    if (!canWriteProjectResource(role, grants, projectId)) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const script = await this.prisma.scriptDraftVersion.findUnique({ where: { id: input.scriptDraftVersionId }, include: { scenes: true, sourceVersion: { select: { projectId: true } } } });
    if (!script || script.sourceVersion.projectId !== projectId) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy script version trong dự án này", status: 404 };
    const orderedScenes = [...script.scenes].sort((a, b) => a.orderIndex - b.orderIndex);
    if (orderedScenes.length === 0) return { ok: false, code: "VALIDATION_FAILED", message: "Script không có scene nào" };
    const audios = await this.prisma.audioVersion.findMany({ where: { sceneDraftVersionId: { in: orderedScenes.map((s) => s.id) }, status: "current" }, select: { sceneDraftVersionId: true, durationMs: true } });
    const voiceBySceneDraftId = new Map(audios.map((a) => [a.sceneDraftVersionId, a.durationMs]));
    const planScript: MediaPlanScript = {
      language: script.language,
      scenes: orderedScenes.map((scene) => ({
        sceneId: scene.sceneId,
        narration: scene.narration,
        screenText: scene.screenText,
        visualQuery: scene.visualQuery,
        durationHintMs: scene.durationHintMs,
        voiceDurationMs: voiceBySceneDraftId.get(scene.id) ?? null,
      })),
      visualPlan: normalizeScriptVisualPlanV2(script.visualPlan, orderedScenes.map((scene) => scene.sceneId)),
    };
    const totalSeconds = planScript.scenes.reduce((total, scene) => total + sceneDuration(scene), 0) / 1000;
    const range = input.range(totalSeconds);
    const ledger = new SegmentSourceLedger();
    const sourced: SourcedSegment[] = [];
    for (const segment of this.planSegments(planScript, range)) {
      let source = await this.findReusableSource(projectId, segment, ledger);
      let errorCode: string | null = null;
      if (!source) {
        const imported = await this.importSegmentSource(projectId, userId, role, { providerAccountId: input.providerAccountId, script: planScript, segment, ledger });
        if (imported.ok) source = imported.data;
        else errorCode = imported.code;
      }
      if (source) ledger.add(source);
      sourced.push({ segment, source, errorCode });
    }
    const built = this.buildBindings(planScript, sourced);
    return {
      ok: true,
      data: {
        policyVersion: MEDIA_PLAN_POLICY_VERSION,
        range,
        scenes: built.scenes.map(({ mediaKind: _mediaKind, ...scene }) => scene),
        segments: built.segments,
        diagnostics: built.diagnostics,
      },
    };
  }
}
