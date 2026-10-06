/**
 * VE2E-37 (CR-JP-ONESHOT-MEDIA-2026-09-29 §3/§8, DEC-2026-09-29-JP-ONESHOT-MEDIA §1/§3): the
 * shared render step turns every timeline scene that carries a source range on a video asset
 * into a small trimmed derivative clip (cut by `apps/media-worker` via RabbitMQ — FFmpeg never
 * runs in this process) and registers it as a `MediaAssetVersion` with lineage
 * (`parentMediaAssetVersionId` + `transform`). Render then sends the derivative, never the full
 * source. A worker failure/timeout fails the render with a clear code; there is no silent
 * fallback to the full source.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import { isSafeRelativePath, isValidMediaAssetTransform, parseMediaAssetTransform, type MediaAssetTransformValue } from "@lyonix/domain";
import { buildClipPrepareJobKey, CLIP_CROP_PROFILE_VERSION, CLIP_PREPARE_PROFILE_VERSION, MediaJobClientError, type ClipPrepareSuccess, type ReframeCropPlan } from "@lyonix/media-jobs";
import { mediaRoot } from "./handoff-workspace.js";
import { MediaJobsGateway, type ClipPreparer } from "./media-jobs.gateway.js";
import { PrismaService } from "./prisma.service.js";
import { ReframeService, type ReframeDecision, type ReframePlanned } from "./reframe.service.js";
import type { RenderOutcome } from "./render-jobs.service.js";

export type ClipDerivativeRequest = {
  sceneId: string;
  parentMediaAssetVersionId: string;
  startMs: number;
  durationMs: number;
  /** Caller intent; forced to true for social (`apify`) parents regardless. */
  stripAudio: boolean;
  /**
   * VE2E-67: `image` = OPTIONAL still-image reframe (one 1080x1920 JPEG, `startMs`/`durationMs` ignored). The derivative is only made
   * when reframing is enabled for the parent's origin and the analysis produced a plan; otherwise the scene keeps the original image.
   */
  mediaKind?: "video" | "image";
};

/** VE2E-67: what the reframe step decided for one prepared item (never silent: fallbacks and unavoidable overlay are flagged). */
export type PreparedReframe = {
  /** `planned` = cropPlan applied; `legacy_fallback` = analysis failed, old centre crop used (see `fallbackCode`); `skipped` = reframe off for this origin. */
  status: "planned" | "legacy_fallback" | "skipped";
  overlayUnavoidable: boolean;
  residualOverlayPct: number;
  subjectCoveragePct: number;
  zoomPermille: number | null;
  confidenceLevel: "high" | "medium" | "low" | null;
  fallbackCode?: string;
  fallbackMessage?: string;
  warnings?: string[];
};

export type PreparedClipDerivative = {
  sceneId: string;
  parentMediaAssetVersionId: string;
  derivativeMediaAssetVersionId: string;
  stripAudio: boolean;
  /** `registry`: an existing derivative row was reused (no worker call); `worker`: media-worker was asked (it may itself reuse by jobKey). */
  source: "registry" | "worker";
  mode: "copy" | "reencode" | null;
  parentBytes: number;
  derivativeBytes: number;
  /** VE2E-67: reframe outcome of this item (Studio shows `overlayUnavoidable` + `residualOverlayPct`; Auto already swapped sources at sourcing time). */
  reframe?: PreparedReframe;
};

export type PreparedClipDerivatives = {
  derivativeBySceneId: Map<string, string>;
  items: PreparedClipDerivative[];
  totals: { parentBytes: number; derivativeBytes: number };
};

/** A reused derivative must stay on disk well past the render's delivery-token window (1h). */
const MIN_REMAINING_TTL_MS = 2 * 60 * 60 * 1000;
const PREPARE_CONCURRENCY = 3;

/**
 * Audio policy: social (`apify`) parents are always stripped (DEC-2026-09-29 §1). Other B-roll is
 * stripped unless the caller explicitly wants the source audio (template path: an explicit
 * non-zero `<Video-N>.volume` in the timeline's optionValues). Stripping is the default because
 * the narration is the soundtrack: the template path already mutes scene video (`volume: 0`) and
 * the dynamic path previously played the B-roll's own audio under the voice.
 */
export const decideStripAudio = (parentOrigin: string, keepSourceAudio: boolean): boolean => parentOrigin === "apify" || !keepSourceAudio;

/** A derivative is reusable only for the SAME crop plan (digest) - or, when no plan applies, only if it was cut without one. */
const cropMatches = (transform: MediaAssetTransformValue | null, cropPlanSha256: string | null): boolean =>
  cropPlanSha256 === null ? transform?.crop === undefined : transform?.crop?.planSha256 === cropPlanSha256;

export const derivativeMatches = (transform: MediaAssetTransformValue | null, range: { startMs: number; durationMs: number }, stripAudio: boolean, cropPlanSha256: string | null = null): boolean =>
  Boolean(transform?.range && transform.range.startMs === range.startMs && transform.range.durationMs === range.durationMs && transform.stripAudio === stripAudio) && cropMatches(transform, cropPlanSha256);

/** VE2E-67: a still-image crop derivative has no range and is identified by its crop plan only. */
export const imageDerivativeMatches = (transform: MediaAssetTransformValue | null, cropPlanSha256: string): boolean =>
  Boolean(transform && transform.range === null && transform.crop?.planSha256 === cropPlanSha256);

const formatBytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)}MB`;

const baseName = (fileName: string) => fileName.replace(/\.[A-Za-z0-9]{1,10}$/, "").slice(0, 120) || "clip";

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

class PrepareFailure extends Error {
  constructor(readonly outcome: Extract<RenderOutcome<never>, { ok: false }>) {
    super(outcome.message);
  }
}

type ParentRow = { id: string; projectId: string; kind: string; origin: string; bytes: number; relativePath: string; originalFileName: string; license: string | null; provenance: unknown; checksumSha256?: string | null };

@Injectable()
export class ClipDerivativesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MediaJobsGateway) private readonly media: ClipPreparer,
    /** VE2E-67: crop-plan analysis. Omitted (unit tests) = no reframing, behaviour identical to VE2E-37. */
    @Optional() @Inject(ReframeService) private readonly reframe?: ReframeService,
  ) {}

  /** Overridable in tests (not DI-injected). */
  now: () => Date = () => new Date();
  log: (message: string) => void = (message) => console.info(message);

  async prepare(projectId: string, userId: string, requests: readonly ClipDerivativeRequest[], onReady?: (ready: number) => Promise<void>, onFailure?: (sceneId: string, code: string, message: string) => Promise<void>): Promise<RenderOutcome<PreparedClipDerivatives>> {
    const result: PreparedClipDerivatives = { derivativeBySceneId: new Map(), items: [], totals: { parentBytes: 0, derivativeBytes: 0 } };
    if (requests.length === 0) return { ok: true, data: result };

    const parentIds = [...new Set(requests.map((r) => r.parentMediaAssetVersionId))];
    const parents = (await this.prisma.mediaAssetVersion.findMany({ where: { id: { in: parentIds }, projectId, deletedAt: null } })) as unknown as ParentRow[];
    const parentById = new Map(parents.map((row) => [row.id, row]));
    for (const request of requests) {
      const parent = parentById.get(request.parentMediaAssetVersionId);
      if (!parent) return { ok: false, code: "NOT_FOUND", message: `Không tìm thấy media nguồn ${request.parentMediaAssetVersionId} của cảnh ${request.sceneId}`, status: 404 };
      if (request.mediaKind === "image") continue; // optional image reframe: a non-image / disabled parent is simply left alone below
      if (parent.kind !== "video") return { ok: false, code: "VALIDATION_FAILED", message: `Cảnh ${request.sceneId}: chỉ cắt được đoạn trên media video` };
    }

    // One derivative per distinct (parent, range, stripAudio) even if several scenes share it.
    type Unique = { key: string; parent: ParentRow; kind: "video" | "image"; startMs: number; durationMs: number; stripAudio: boolean; sceneIds: string[] };
    const unique = new Map<string, Unique>();
    for (const request of requests) {
      const parent = parentById.get(request.parentMediaAssetVersionId)!;
      const kind = request.mediaKind === "image" ? "image" : "video";
      if (kind === "image" && (parent.kind !== "image" || !this.reframe?.enabledFor(parent.origin))) continue;
      const stripAudio = kind === "image" ? true : decideStripAudio(parent.origin, !request.stripAudio);
      const key = kind === "image" ? `${parent.id}|image` : `${parent.id}|${request.startMs}|${request.durationMs}|${stripAudio}`;
      const entry = unique.get(key) ?? { key, parent, kind, startMs: kind === "image" ? 0 : request.startMs, durationMs: kind === "image" ? 0 : request.durationMs, stripAudio, sceneIds: [] };
      entry.sceneIds.push(request.sceneId);
      unique.set(key, entry);
    }

    type PreparedEntry = { entry: Unique; derivativeId: string | null; source: "registry" | "worker"; mode: "copy" | "reencode" | null; bytes: number; reframe: PreparedReframe | null };
    let prepared: PreparedEntry[];
    let ready = 0;
    try {
      prepared = await mapWithConcurrency([...unique.values()], PREPARE_CONCURRENCY, async (entry): Promise<PreparedEntry> => {
        try {
          const decision = await this.decideReframe(entry);
          if (decision.status === "failed") {
            throw new PrepareFailure({ ok: false, code: "MEDIA_PREPARE_FAILED", message: `Không phân tích được khung cắt (${decision.code}): ${decision.message} - REFRAME_LEGACY_FALLBACK đang tắt`, status: 503, retryable: decision.retryable });
          }
          const planned = decision.status === "planned" ? decision : null;
          const reframe = this.describeReframe(decision);
          if (entry.kind === "image" && !planned) return { entry, derivativeId: null, source: "worker", mode: null, bytes: 0, reframe }; // original image stays
          const reusable = await this.findReusable(projectId, entry.parent.id, entry, entry.stripAudio, entry.kind, planned?.cropPlanSha256 ?? null);
          if (reusable) {
            if (onReady && entry.kind === "video") await onReady(++ready); // image reframes are optional extras: not part of the clips-ready progress
            return { entry, derivativeId: reusable.id, source: "registry" as const, mode: null, bytes: reusable.bytes, reframe };
          }
          const output = await this.cut(entry.parent, entry.startMs, entry.durationMs, entry.stripAudio, entry.kind, planned);
          const row = await this.register(projectId, userId, entry.parent, entry, entry.stripAudio, output, entry.kind, planned, decision);
          if (onReady && entry.kind === "video") await onReady(++ready); // image reframes are optional extras: not part of the clips-ready progress
          return { entry, derivativeId: row.id, source: "worker" as const, mode: output.mode, bytes: output.output.bytes, reframe };
        } catch (error) {
          if (error instanceof PrepareFailure && onFailure) await onFailure(entry.sceneIds[0]!, error.outcome.code, error.outcome.message);
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof PrepareFailure) return error.outcome;
      throw error;
    }

    for (const item of prepared) {
      if (item.derivativeId === null) continue; // optional image reframe that did not apply: the scene keeps its original image
      result.totals.parentBytes += item.entry.parent.bytes;
      result.totals.derivativeBytes += item.bytes;
      for (const sceneId of item.entry.sceneIds) {
        result.derivativeBySceneId.set(sceneId, item.derivativeId);
        result.items.push({
          sceneId,
          parentMediaAssetVersionId: item.entry.parent.id,
          derivativeMediaAssetVersionId: item.derivativeId,
          stripAudio: item.entry.stripAudio,
          source: item.source,
          mode: item.mode,
          parentBytes: item.entry.parent.bytes,
          derivativeBytes: item.bytes,
          ...(item.reframe ? { reframe: item.reframe } : {}),
        });
      }
      this.log(
        `[clip-derivatives] project=${projectId} parent=${item.entry.parent.id} ${item.entry.kind === "image" ? "image" : `range=${item.entry.startMs}+${item.entry.durationMs}ms`} stripAudio=${item.entry.stripAudio} ` +
          `${item.source}${item.mode ? `/${item.mode}` : ""} bytes ${formatBytes(item.entry.parent.bytes)} -> ${formatBytes(item.bytes)} derivative=${item.derivativeId}` +
          (item.reframe ? ` reframe=${item.reframe.status}${item.reframe.overlayUnavoidable ? ` overlay_unavoidable(${item.reframe.residualOverlayPct}%)` : ""}${item.reframe.fallbackCode ? ` fallback=${item.reframe.fallbackCode}` : ""}` : ""),
      );
    }
    const { parentBytes, derivativeBytes } = result.totals;
    this.log(
      `[clip-derivatives] project=${projectId} ${prepared.length} clip(s): payload ${formatBytes(parentBytes)} -> ${formatBytes(derivativeBytes)}` +
        (parentBytes > 0 ? ` (${Math.round((1 - derivativeBytes / parentBytes) * 100)}% smaller)` : ""),
    );
    return { ok: true, data: result };
  }

  /** VE2E-67: crop plan for this entry (video: for the exact range that will be cut). Never throws; no reframe service = skipped. */
  private async decideReframe(entry: { parent: ParentRow; kind: "video" | "image"; startMs: number; durationMs: number }): Promise<ReframeDecision> {
    if (!this.reframe) return { status: "skipped", reason: "disabled" };
    const source = { id: entry.parent.id, kind: entry.kind, origin: entry.parent.origin, relativePath: entry.parent.relativePath, checksumSha256: entry.parent.checksumSha256 ?? null };
    return this.reframe.plan(source, entry.kind === "video" ? { startMs: entry.startMs, durationMs: entry.durationMs } : null);
  }

  private describeReframe(decision: ReframeDecision): PreparedReframe {
    if (decision.status === "planned") {
      return {
        status: "planned",
        overlayUnavoidable: decision.overlayUnavoidable,
        residualOverlayPct: decision.residualOverlayPct,
        subjectCoveragePct: decision.subjectCoveragePct,
        zoomPermille: decision.zoomPermille,
        confidenceLevel: decision.confidenceLevel,
        ...(decision.warnings.length > 0 ? { warnings: decision.warnings } : {}),
      };
    }
    if (decision.status === "legacy_fallback") {
      return { status: "legacy_fallback", overlayUnavoidable: false, residualOverlayPct: 0, subjectCoveragePct: 100, zoomPermille: null, confidenceLevel: null, fallbackCode: decision.code, fallbackMessage: decision.message };
    }
    return { status: "skipped", overlayUnavoidable: false, residualOverlayPct: 0, subjectCoveragePct: 100, zoomPermille: null, confidenceLevel: null };
  }

  private async findReusable(projectId: string, parentId: string, range: { startMs: number; durationMs: number }, stripAudio: boolean, kind: "video" | "image" = "video", cropPlanSha256: string | null = null) {
    const candidates = await this.prisma.mediaAssetVersion.findMany({
      where: { projectId, parentMediaAssetVersionId: parentId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    const minExpiry = this.now().getTime() + MIN_REMAINING_TTL_MS;
    for (const candidate of candidates) {
      const parsed = parseMediaAssetTransform(candidate.transform);
      if (kind === "image" ? !(cropPlanSha256 && imageDerivativeMatches(parsed, cropPlanSha256)) : !derivativeMatches(parsed, range, stripAudio, cropPlanSha256)) continue;
      if (candidate.expiresAt && candidate.expiresAt.getTime() <= minExpiry) continue;
      if (!isSafeRelativePath(candidate.relativePath)) continue;
      const onDisk = await stat(join(mediaRoot(), candidate.relativePath)).then((info) => info.isFile() && info.size === candidate.bytes).catch(() => false);
      if (onDisk) return candidate;
    }
    return null;
  }

  private async cut(parent: ParentRow, startMs: number, durationMs: number, stripAudio: boolean, kind: "video" | "image" = "video", planned: ReframePlanned | null = null): Promise<ClipPrepareSuccess> {
    let result;
    const cropPlan: ReframeCropPlan | null = planned?.cropPlan ?? null;
    try {
      result = await this.media.prepareClip({
        jobKey: buildClipPrepareJobKey({ sourceMediaAssetVersionId: parent.id, startMs, durationMs, stripAudio, ...(cropPlan ? { cropPlanSha256: planned!.cropPlanSha256 } : {}), ...(kind === "image" ? { kind } : {}) }),
        source: { relativePath: parent.relativePath, mediaAssetVersionId: parent.id, ...(kind === "image" ? { kind } : {}) },
        startMs,
        durationMs,
        stripAudio,
        ...(cropPlan ? { cropPlan } : {}),
      });
    } catch (error) {
      if (error instanceof MediaJobClientError && error.code === "MEDIA_WORKER_NOT_CONFIGURED") {
        throw new PrepareFailure({ ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Media worker chưa cấu hình (RABBITMQ_URL) — không cắt được clip để render", status: 503, retryable: false });
      }
      if (error instanceof MediaJobClientError && error.code === "INVALID_JOB") {
        throw new PrepareFailure({ ok: false, code: "VALIDATION_FAILED", message: `Yêu cầu cắt clip không hợp lệ: ${error.message} — không gửi file gốc`, retryable: false });
      }
      const detail = error instanceof MediaJobClientError ? error.code : "UNKNOWN";
      throw new PrepareFailure({
        ok: false,
        code: "MEDIA_PREPARE_FAILED",
        message: `Media worker không trả kết quả cắt clip (${detail}) — thử render lại; không gửi file gốc`,
        status: 503,
        retryable: true,
      });
    }
    if (!result.ok) {
      const { code, message, retryable } = result.error;
      throw new PrepareFailure(
        retryable
          ? { ok: false, code: "MEDIA_PREPARE_FAILED", message: `Media worker lỗi khi cắt clip (${code}): ${message}`, status: 503, retryable: true }
          : { ok: false, code: "VALIDATION_FAILED", message: `Không cắt được đoạn media (${code}): ${message}`, retryable: false },
      );
    }
    if (stripAudio && result.output.hasAudio) {
      throw new PrepareFailure({ ok: false, code: "MEDIA_PREPARE_FAILED", message: "Clip đã cắt vẫn còn audio dù yêu cầu bỏ audio", status: 503, retryable: true });
    }
    if (!isSafeRelativePath(result.output.relativePath)) {
      throw new PrepareFailure({ ok: false, code: "MEDIA_PREPARE_FAILED", message: "Media worker trả về đường dẫn không hợp lệ", status: 503, retryable: false });
    }
    return result;
  }

  private async register(
    projectId: string,
    userId: string,
    parent: ParentRow,
    range: { startMs: number; durationMs: number },
    stripAudio: boolean,
    result: ClipPrepareSuccess,
    kind: "video" | "image" = "video",
    planned: ReframePlanned | null = null,
    decision: ReframeDecision | null = null,
  ) {
    const transform: MediaAssetTransformValue = {
      range: kind === "image" ? null : { startMs: range.startMs, durationMs: range.durationMs },
      stripAudio,
      tool: { name: "ffmpeg", version: result.tool.ffmpegVersion.slice(0, 200) || "unknown" },
      profileVersion: result.tool.profileVersion ?? CLIP_PREPARE_PROFILE_VERSION,
      ...(planned
        ? {
            crop: {
              planSha256: planned.cropPlanSha256,
              planVersion: planned.cropPlan.version,
              mode: planned.cropPlan.mode,
              zoomPermille: planned.zoomPermille,
              overlayUnavoidable: planned.overlayUnavoidable,
              residualOverlayPct: planned.residualOverlayPct,
              subjectCoveragePct: planned.subjectCoveragePct,
              cropProfileVersion: result.reframe?.cropProfileVersion ?? CLIP_CROP_PROFILE_VERSION,
            },
          }
        : {}),
    };
    if (!isValidMediaAssetTransform(transform)) throw new PrepareFailure({ ok: false, code: "MEDIA_PREPARE_FAILED", message: "Transform derivative không hợp lệ", status: 500, retryable: false });
    const parentProvenance = parent.provenance && typeof parent.provenance === "object" && !Array.isArray(parent.provenance) ? (parent.provenance as Record<string, unknown>) : {};
    return this.prisma.mediaAssetVersion.create({
      data: {
        projectId,
        folderId: null,
        kind,
        originalFileName: kind === "image" ? `${baseName(parent.originalFileName)}.crop.jpg` : `${baseName(parent.originalFileName)}.clip-${range.startMs}-${range.durationMs}.mp4`,
        mimeType: result.output.mimeType,
        checksumSha256: result.output.sha256,
        bytes: result.output.bytes,
        widthPx: result.output.width,
        heightPx: result.output.height,
        durationMs: kind === "image" ? null : result.output.durationMs,
        // Lineage keeps the parent's origin/license/attribution so rights tracking (e.g. apify
        // `owner_accepted_risk`, Pexels attribution) follows the clip that is actually rendered.
        origin: parent.origin as never,
        license: parent.license,
        provenance: {
          ...parentProvenance,
          derivative: {
            jobKey: result.jobKey,
            mode: result.mode,
            reencodeReasons: result.reencodeReasons,
            cut: result.cut,
            drift: result.drift,
            toleranceMs: result.toleranceMs,
            parentBytes: parent.bytes,
            // VE2E-67 lineage: source + crop plan + tool/profile versions + checksum (also on the row itself) of what was actually applied.
            ...(planned
              ? {
                  cropPlan: planned.cropPlan,
                  reframe: {
                    status: "planned",
                    analysisJobKey: planned.analysisJobKey,
                    analysisReused: planned.analysisReused,
                    confidenceLevel: planned.confidenceLevel,
                    warnings: planned.warnings,
                    overlayUnavoidable: planned.overlayUnavoidable,
                    residualOverlayPct: planned.residualOverlayPct,
                    tool: planned.tool,
                    cropProfileVersion: result.reframe?.cropProfileVersion ?? CLIP_CROP_PROFILE_VERSION,
                    applied: result.reframe?.applied ?? null,
                    outputSha256: result.output.sha256,
                  },
                }
              : decision && decision.status === "legacy_fallback"
                ? { reframe: { status: "legacy_fallback", fallbackCode: decision.code, fallbackMessage: decision.message.slice(0, 300) } }
                : {}),
          },
        } as Prisma.InputJsonValue,
        reusable: false,
        retentionClass: "working",
        relativePath: result.output.relativePath,
        expiresAt: new Date(result.output.expiresAt),
        createdByUserId: userId,
        parentMediaAssetVersionId: parent.id,
        transform: transform as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
