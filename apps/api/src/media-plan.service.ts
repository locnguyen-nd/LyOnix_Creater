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
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  MAX_QUERY_VARIANTS,
  MEDIA_PLAN_POLICY_VERSION,
  canWriteProjectResource,
  computeSegmentSourceRanges,
  computeSocialWindowRanges,
  computeWindowRangesWithLoopFallback,
  socialWindowOptionsFromEnv,
  deriveSceneBrief,
  planBackgroundSegments,
  type MediaPlanScene,
  type PlannedSegment,
  type SceneBrief,
  type SceneSourceRange,
} from "@lyonix/domain";
import type {
  ErrorCode,
  MediaPlanApifyQuality,
  MediaPlanApifyUsage,
  MediaPlanVisionUsage,
  MediaPlanResponse,
  MediaPlanSegmentDiagnostics,
  ScriptVisualPlanResponse,
  TimelineSceneBindingInput,
  TimelineSegmentInput,
} from "@lyonix/contracts";
import { ProviderError, isValidJaSearchKeyword, normalizeScriptVisualPlanV2 } from "@lyonix/providers";
import { getSharedProviderLimiter } from "./concurrency-config.js";
import { isApifyPlatform, type ApifyPlatform } from "@lyonix/providers";
import { randomUUID } from "node:crypto";
import { ScriptGenerationService } from "./script-generation.service.js";
import { ApifyJobContext, ApifyService } from "./apify.service.js";
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
  /** VE2E-46: which provider produced the source (reused assets are classified by their stored `origin`). */
  provider?: "apify" | "pexels";
  /** VE2E-46: recorded when Apify was tried/skipped and the source came from the Pexels fallback. */
  fallbackReason?: string | null;
  apifyProvenance?: MediaPlanSegmentDiagnostics["apifyProvenance"];
  /** VE2E-51: candidate filtering / two-phase details of the Apify attempt (kept when it fell back to Pexels). */
  apifyQuality?: MediaPlanApifyQuality | null;
  /** VE2E-57: vision moderation was skipped for this segment (budget spent or model cooling down); metadata-only ranking decided. */
  visionSkipped?: "vision_skipped_budget" | "vision_skipped_quota";
};

export type SourcedSegment = { segment: PlannedSegment; source: SegmentSource | null; errorCode: string | null };

/** Serialises async sections (used for the Pexels fallback so concurrent segments never pick the same stock clip). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const plainExternalId = (id: string) => (id.startsWith("apify:") ? id.split(":").slice(2).join(":") : id);

/** Tracks what earlier segments of one plan already used - a new segment must never pick any of these. */
export class SegmentSourceLedger {
  readonly externalIds = new Set<string>();
  readonly assetIds = new Set<string>();
  /**
   * VE2E-51: plain platform video ids (`apify:tiktok:<id>` -> `<id>`), a LIVE set shared with `ApifyService.autoImportForSegment`,
   * which reserves the chosen id in it before any await so concurrently sourced segments cannot pick the same clip.
   */
  readonly apifyPlainIds = new Set<string>();
  readonly pexelsLock = new Mutex();
  add(source: SegmentSource) {
    this.assetIds.add(source.mediaAssetVersionId);
    if (source.externalId) {
      this.externalIds.add(source.externalId);
      this.apifyPlainIds.add(plainExternalId(source.externalId));
    }
  }
}

/** VE2E-51: at most this many segments are sourced at once. */
export const MEDIA_PLAN_SOURCING_CONCURRENCY = 3;
/** Window guards per provider: social (Apify) clips skip the author's intro/outro, stock (Pexels) clips are used from the first frame to the last. */
const windowOptionsFor = (provider: string | undefined) => (provider === "apify" ? socialWindowOptionsFromEnv() : { startGuardMs: 0, endGuardMs: 0 });
/** VE2E-53: how many times a segment may be split to source the scenes a short social clip cannot cover. */
const MAX_SECOND_SOURCE_SPLITS = 2;

/** Pexels imports are registered as `pexels-<id>.<ext>` (pexels.service.ts `import`); that is the only place the external id survives on the asset row. */
export const pexelsExternalIdFromFileName = (fileName: string): string | null => /^pexels-(\d+)\./.exec(fileName)?.[1] ?? null;

/** VE2E-34 registers Apify imports as `apify-<platform>-<id>.<ext>`; the segment ledger tracks them as `apify:<platform>:<id>` (same as `candidate.source:externalId`). */
export const apifyLedgerIdFromFileName = (fileName: string): string | null => {
  const match = /^apify-([a-z_]+)-([A-Za-z0-9_-]+)\.[a-z0-9]+$/.exec(fileName);
  return match ? `apify:${match[1]}:${match[2]}` : null;
};

/** Approved platforms for unattended sourcing (Google video is never importable). Env `APIFY_AUTO_PLATFORM`, default TikTok. */
export const apifyAutoPlatformFromEnv = (): ApifyPlatform => {
  const value = process.env.APIFY_AUTO_PLATFORM;
  return isApifyPlatform(value) && value !== "google_video" ? value : "tiktok";
};

/**
 * Ordered platforms tried per segment before falling back to Pexels: env `APIFY_AUTO_PLATFORMS` (comma list, e.g. `tiktok,pinterest`);
 * legacy single `APIFY_AUTO_PLATFORM` still wins when the list is unset. Default `tiktok,pinterest` (Pinterest = curated, better
 * caption/scene fit when TikTok yields nothing usable). Unknown values and `google_video` are dropped; empty -> TikTok only.
 */
const VIDEO_PLATFORMS: ReadonlySet<ApifyPlatform> = new Set<ApifyPlatform>(["tiktok", "x"]);
const IMAGE_PLATFORMS: ReadonlySet<ApifyPlatform> = new Set<ApifyPlatform>(["pinterest", "google_image"]);
const parsePlatformList = (raw: string, allowed: ReadonlySet<ApifyPlatform>, fallback: ApifyPlatform[]): ApifyPlatform[] => {
  const list = raw.split(",").map((v) => v.trim()).filter((v): v is ApifyPlatform => isApifyPlatform(v) && allowed.has(v));
  const unique = [...new Set(list)];
  return unique.length > 0 ? unique : fallback;
};

/** Platforms for VIDEO slots, in order: env `APIFY_VIDEO_PLATFORMS` (alias `APIFY_AUTO_PLATFORMS`; legacy single `APIFY_AUTO_PLATFORM`), default TikTok. Image-only platforms are never used for a video slot. */
export const apifyAutoPlatformsFromEnv = (): ApifyPlatform[] => {
  const raw = process.env.APIFY_VIDEO_PLATFORMS ?? process.env.APIFY_AUTO_PLATFORMS;
  if (raw !== undefined) return parsePlatformList(raw, VIDEO_PLATFORMS, ["tiktok"]);
  return process.env.APIFY_AUTO_PLATFORM ? [apifyAutoPlatformFromEnv()] : ["tiktok"];
};

/** Platforms for IMAGE slots, in order: env `APIFY_IMAGE_PLATFORMS`, default Pinterest. */
export const apifyImagePlatformsFromEnv = (): ApifyPlatform[] => parsePlatformList(process.env.APIFY_IMAGE_PLATFORMS ?? "", IMAGE_PLATFORMS, ["pinterest"]);

/** Kind a segment must be sourced as: the template slot's kind when the planner knows it, else video (legacy). */
export const segmentVisualKind = (segment: PlannedSegment): "video" | "image" => segment.visualKind ?? "video";

/**
 * The Japanese Apify keyword of a segment (VE2E-50): only `segment.keywords.ja` when it is a real short
 * Japanese search phrase (kana/kanji, see `isValidJaSearchKeyword`). The scene `visualQuery` is NEVER
 * used (VE2E-48's fallback was wrong: for a ja script it is a long English shot description that returns
 * global template/greenscreen TikToks). No valid keyword -> `null` -> Pexels with reason `no_ja_keywords`.
 */
export const apifyKeywordForSegment = (segment: PlannedSegment): string | null => {
  const planned = segment.keywords?.ja.trim();
  return planned && isValidJaSearchKeyword(planned) ? planned : null;
};

/** Segments that would be sent to Apify without a valid ja keyword (plan missing or the ja keyword failed validation): input of the dedicated keyword extraction. */
export const segmentsNeedingKeywords = (segments: readonly PlannedSegment[]): PlannedSegment[] => segments.filter((segment) => apifyKeywordForSegment(segment) === null);

/** Narration of a segment's scenes in script order (the only text the keyword extraction sees). */
export const segmentNarration = (script: MediaPlanScript, segment: PlannedSegment): string =>
  segment.sceneIds.map((sceneId) => script.scenes.find((scene) => scene.sceneId === sceneId)?.narration.trim() ?? "").filter(Boolean).join(" ");

/** Applies extracted keywords to the planned segments in place; `en` from the plan wins, extracted `en` only fills a gap. */
export const applyExtractedKeywords = (segments: readonly PlannedSegment[], extracted: Readonly<Record<string, { ja: string; en: string }>>): void => {
  for (const segment of segments) {
    const found = extracted[segment.segmentId];
    if (!found || !isValidJaSearchKeyword(found.ja)) continue;
    segment.keywords = { ja: found.ja.trim(), en: segment.keywords?.en.trim() || found.en.trim() };
  }
};

const sceneDuration = (scene: MediaPlanScriptScene) => Math.max(1, Math.round(scene.voiceDurationMs ?? scene.durationHintMs));

@Injectable()
export class MediaPlanService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(PexelsService) private readonly pexels: PexelsService,
    /** VE2E-46: Apify-first sourcing. Absent (older 3-argument construction) = unchanged Pexels-only behaviour. */
    @Optional() @Inject(ApifyService) private readonly apify?: ApifyService,
    /** VE2E-55: keyword extraction for Studio plans. Absent = no extraction (segments without a ja keyword go to Pexels). */
    @Optional() @Inject(ScriptGenerationService) private readonly scriptGeneration?: ScriptGenerationService,
  ) {}

  /**
   * Job-level check of the media on/off switches: the chosen media account (Pexels) must be on, or an Apify account must be on.
   * Both off (or not usable) -> a clear failure before any provider is called.
   */
  async checkMediaSourcesEnabled(userId: string, role: "admin" | "staff", mediaAccountId: string): Promise<{ ok: true } | { ok: false; code: "PROVIDER_CAPABILITY_UNAVAILABLE"; message: string }> {
    const selected = await this.prisma.providerAccount.findFirst({ where: { id: mediaAccountId, deletedAt: null }, select: { provider: true, enabled: true } });
    if (selected?.provider === "pexels" && selected.enabled !== false) return { ok: true };
    if (selected?.provider === "apify" && selected.enabled !== false) return { ok: true };
    if (this.apify && (await this.apify.findAccountForUser(userId, role))) return { ok: true };
    return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Các nguồn media (Pexels/Apify) đều đang tắt hoặc chưa sẵn sàng; bật ít nhất một nguồn trong cấu hình provider." };
  }

  /**
   * VE2E-55: Studio counterpart of the Auto runner's extraction. One call for all given segments lacking a valid ja
   * keyword; applies the result in place. Returns the reason to record when segments stay without a keyword
   * (`no_content_account` | `extraction_failed`), else null. Never throws; the call is recorded as a ProviderOperation.
   */
  private async extractKeywordsForStudio(userId: string, role: "admin" | "staff", script: MediaPlanScript, segments: PlannedSegment[]): Promise<string | null> {
    const needing = segmentsNeedingKeywords(segments);
    if (needing.length === 0 || !this.scriptGeneration) return null;
    if (!(await this.apifyAvailable(userId, role))) return null;
    let accountId: string | null = null;
    try {
      accountId = await this.scriptGeneration.resolveContentAccountId(userId, role);
    } catch {
      accountId = null;
    }
    if (!accountId) return "no_content_account";
    const record = async (status: "succeeded" | "failed", errorCode: string | null, requestId: string | null) => {
      try {
        await this.prisma.providerOperation.create({ data: { providerAccountId: accountId, role: "content", operation: "extract_keywords", status, correlationId: randomUUID(), errorCode, externalRequestId: requestId } });
      } catch {
        // Bookkeeping is best-effort.
      }
    };
    try {
      const outcome = await this.scriptGeneration.extractSegmentKeywords(userId, role, {
        providerAccountId: accountId,
        language: script.language,
        segments: needing.map((segment) => ({ segmentId: segment.segmentId, narration: segmentNarration(script, segment) })),
      });
      if (!outcome.ok) {
        await record("failed", outcome.code, null);
        return "extraction_failed";
      }
      await record("succeeded", null, outcome.usage.providerRequestId);
      applyExtractedKeywords(segments, outcome.keywords);
      return null;
    } catch {
      await record("failed", "PROVIDER_UNAVAILABLE", null);
      return "extraction_failed";
    }
  }

  /** VE2E-50: whether the user can run an Apify search at all (the runner only pays for keyword extraction when it can). */
  async apifyAvailable(userId: string, role: "admin" | "staff"): Promise<boolean> {
    if (!this.apify) return false;
    try {
      return Boolean(await this.apify.findAccountForUser(userId, role));
    } catch {
      return false;
    }
  }

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
    const externalId = pexelsExternalIdFromFileName(row.originalFileName) ?? apifyLedgerIdFromFileName(row.originalFileName);
    if (ledger.assetIds.has(row.id) || (externalId && ledger.externalIds.has(externalId))) return null;
    return { mediaAssetVersionId: row.id, kind: row.kind, durationMs: row.durationMs, externalId, sourcing: "reused", ...(row.origin === "apify" ? { provider: "apify" as const } : {}) };
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

  /**
   * VE2E-46: Apify first. Runs only when the segment has `keywords.ja` AND the user can see a verified Apify account; a single
   * Apify search (ja) is ranked + moderated once by `ApifyService.autoImportForSegment`. Returns the source, or the reason to
   * fall back to Pexels (recorded in diagnostics). Never throws.
   */
  private async tryApify(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { script: MediaPlanScript; segment: PlannedSegment; ledger: SegmentSourceLedger; job?: ApifyJobContext },
  ): Promise<{ source: SegmentSource } | { reason: string | null; quality?: MediaPlanApifyQuality | null }> {
    if (!this.apify) return { reason: null };
    const keyword = apifyKeywordForSegment(input.segment);
    if (!keyword) return { reason: "no_ja_keywords" };
    try {
      const account = await this.apify.findAccountForUser(userId, role);
      if (!account) return { reason: "no_apify_account" };
      const brief = this.segmentBrief(input.script, input.segment);
      // Live set (VE2E-51): ApifyService reserves the chosen video id in it so segments sourced in parallel never share a clip.
      const usedExternalIds = input.ledger.apifyPlainIds;
      let outcome: Awaited<ReturnType<ApifyService["autoImportForSegment"]>> | null = null;
      let firstFailure: { reason: string; quality: MediaPlanApifyQuality | null } | null = null;
      // Ordered multi-platform sourcing: the next platform is only searched when the previous one yielded no usable/relevant clip.
      const visualKind = segmentVisualKind(input.segment);
      for (const platform of visualKind === "image" ? apifyImagePlatformsFromEnv() : apifyAutoPlatformsFromEnv()) {
        // VE2E-61: every Apify call goes through the shared per-provider limiter (FIFO wait + timeout), also for the 2nd/3rd platform.
        const attempt = await getSharedProviderLimiter().run("apify", () => this.apify!.autoImportForSegment(projectId, userId, role, account, {
          platform,
          mediaType: visualKind,
          keyword,
          brief: { ...brief, phrases: [keyword, ...brief.phrases.filter((phrase) => phrase !== keyword)].slice(0, MAX_QUERY_VARIANTS) },
          sceneId: input.segment.sceneIds[0]!,
          usedExternalIds,
          scriptLanguage: input.script.language,
          segmentDurationSeconds: input.segment.durationMs / 1000,
          ...(input.job ? { job: input.job } : {}),
        }));
        if (attempt.ok) { outcome = attempt; break; }
        firstFailure ??= { reason: attempt.reason, quality: attempt.quality ?? null };
      }
      if (!outcome) return { reason: firstFailure?.reason ?? "apify_no_platform", quality: firstFailure?.quality ?? null };
      const asset = outcome.data.asset;
      if ((asset.kind !== "video" && asset.kind !== "image") || input.ledger.assetIds.has(asset.id) || input.ledger.externalIds.has(outcome.data.ledgerId)) {
        // Release the reservation made by ApifyService (the ledger itself never held this clip).
        if (!input.ledger.externalIds.has(outcome.data.ledgerId)) usedExternalIds.delete(outcome.data.externalId);
        return { reason: "apify_duplicate_or_unsupported_source", quality: outcome.data.quality };
      }
      const provenance = outcome.data.provenance;
      return {
        source: {
          mediaAssetVersionId: asset.id,
          kind: asset.kind,
          durationMs: asset.durationMs,
          externalId: outcome.data.ledgerId,
          sourcing: "imported",
          provider: "apify",
          apifyProvenance: provenance ? { platform: provenance.platform, actorId: provenance.actorId, actorVersion: provenance.actorVersion, sourceUrl: provenance.sourceUrl, author: provenance.author, fetchedAt: provenance.fetchedAt } : null,
          apifyQuality: outcome.data.quality,
        },
      };
    } catch (error) {
      // VE2E-61: a limiter wait timeout is a queueing problem, not an Apify failure; the segment still falls back to Pexels.
      if (error instanceof ProviderError && error.code === "PROVIDER_RATE_LIMITED") return { reason: "apify_queue_timeout" };
      return { reason: "apify_error:unexpected" };
    }
  }

  /** Searches/ranks/moderates/imports one new source for the segment: Apify first (VE2E-46), then the existing Pexels gate, excluding every source an earlier segment used. */
  async importSegmentSource(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; script: MediaPlanScript; segment: PlannedSegment; ledger: SegmentSourceLedger; job?: ApifyJobContext },
  ): Promise<MediaPlanOutcome<SegmentSource>> {
    const apifyAttempt = await this.tryApify(projectId, userId, role, input);
    if ("source" in apifyAttempt) return { ok: true, data: apifyAttempt.source };
    const fallbackReason = apifyAttempt.reason;
    const apifyQuality = apifyAttempt.quality ?? null;
    const brief = this.segmentBrief(input.script, input.segment);
    const firstScene = input.script.scenes.find((scene) => scene.sceneId === input.segment.sceneIds[0]);
    // Serialised per plan: the ledger snapshot handed to Pexels must include every earlier fallback's clip (segments run concurrently).
    return input.ledger.pexelsLock.run(async (): Promise<MediaPlanOutcome<SegmentSource>> => {
      const outcome = await getSharedProviderLimiter().run("pexels", () => this.pexels.autoImportForScene(projectId, userId, role, {
        providerAccountId: input.providerAccountId,
        sceneId: input.segment.sceneIds[0]!,
        query: brief.phrases[0] ?? firstScene?.visualQuery ?? "",
        sceneBrief: brief,
        usedExternalIds: [...input.ledger.externalIds],
        // Template-aware sourcing: an image slot gets a photo, a video slot a video (no cross-kind fallback). Unknown kind = legacy.
        ...(input.segment.visualKind ? { mediaType: input.segment.visualKind } : {}),
        ...(input.job ? { visionBudget: input.job.vision } : {}),
      }));
      if (!outcome.ok) return outcome;
      const asset = outcome.data.asset;
      if (asset.kind !== "video" && asset.kind !== "image") return { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: `Asset Pexels vừa import có kind không hỗ trợ: ${asset.kind}` };
      if (input.ledger.assetIds.has(asset.id)) {
        // Same bytes as an earlier segment's source (checksum dedupe in MediaService) - a new segment must use a different source.
        return { ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "Nguồn tìm được trùng với nguồn của segment trước; cần chọn thủ công trong Studio.", status: 422 };
      }
      const source: SegmentSource = { mediaAssetVersionId: asset.id, kind: asset.kind, durationMs: asset.durationMs, externalId: outcome.data.externalId, sourcing: "imported", provider: "pexels", fallbackReason, ...(apifyQuality ? { apifyQuality } : {}) };
      input.ledger.add(source);
      return { ok: true, data: source };
    });
  }

  /**
   * VE2E-51: sources every segment with bounded concurrency ({@link MEDIA_PLAN_SOURCING_CONCURRENCY} = 3), sharing one
   * `ApifyJobContext` (identical (platform, keyword) searches share one Actor run; per-job usage is returned). Each segment first
   * tries `findReusableSource` (retry/Studio idempotency), else `importSegmentSource` (optionally wrapped by `runImport`, which
   * the Auto runner uses for its per-segment StepRun bookkeeping and may throw). A source is added to the ledger the moment it is
   * known, so a later segment can never take it. `stopOnFailure` (Auto): after the first thrown failure no new segment starts,
   * in-flight ones finish, and the failure with the lowest segment index is returned in `failure`. Results keep segment order.
   */
  async sourceSegments(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: {
      providerAccountId: string;
      script: MediaPlanScript;
      segments: PlannedSegment[];
      ledger: SegmentSourceLedger;
      concurrency?: number;
      stopOnFailure?: boolean;
      /**
       * VE2E-50/55 x VE2E-51: called ONCE, before the concurrent sourcing starts, with the segments that need a NEW source
       * (not reusable from the project library). Runs the single keyword-extraction call for all of them and may mutate the
       * planned segments' keywords in place. A returned string is the reason recorded on segments that still fall back to
       * Pexels for lack of a ja keyword (replaces the generic `no_ja_keywords`).
       */
      beforeSourcing?: (pending: PlannedSegment[]) => Promise<string | null | void>;
      runImport?: (segment: PlannedSegment, task: () => Promise<MediaPlanOutcome<SegmentSource>>) => Promise<MediaPlanOutcome<SegmentSource>>;
    },
  ): Promise<{ sourced: SourcedSegment[]; failure: { segment: PlannedSegment; error: unknown } | null; apifyUsage: MediaPlanApifyUsage | null; visionUsage: MediaPlanVisionUsage | null }> {
    let extractionReason: string | null = null;
    if (input.beforeSourcing) {
      const pending: PlannedSegment[] = [];
      for (const segment of input.segments) if (!(await this.findReusableSource(projectId, segment, input.ledger))) pending.push(segment);
      if (pending.length > 0) extractionReason = (await input.beforeSourcing(pending)) ?? null;
    }
    const job = new ApifyJobContext();
    // VE2E-67 (CR-SUBJECT-REFRAME Q5): Auto (`stopOnFailure`) swaps a candidate whose overlay cannot be avoided; Studio only flags it.
    job.overlayPolicy = input.stopOnFailure ? "swap" : "flag";
    const results: Array<SourcedSegment[] | undefined> = new Array(input.segments.length).fill(undefined);
    let failure: { index: number; error: unknown } | null = null;
    let next = 0;
    const segmentMs = (sceneIds: string[]) => sceneIds.reduce((total, sceneId) => total + (input.script.scenes.find((s) => s.sceneId === sceneId) ? sceneDuration(input.script.scenes.find((s) => s.sceneId === sceneId)!) : 1), 0);
    /**
     * VE2E-53 second source: a social (Apify) clip whose guard-bounded window cannot cover every scene of its segment no longer
     * leaves those scenes on a clip that does not fit. The segment is split at the coverage boundary and the uncovered scenes are
     * sourced as their own segment (`<id>-b`), up to {@link MAX_SECOND_SOURCE_SPLITS} times. If the extra source cannot be found the
     * original single-source behaviour is kept, so a run never fails because of this refinement.
     */
    const withSecondSource = async (head: SourcedSegment, depth: number): Promise<SourcedSegment[]> => {
      const { segment, source } = head;
      if (!source || depth >= MAX_SECOND_SOURCE_SPLITS || source.kind !== "video") return [head];
      const durations = segment.sceneIds.map((sceneId) => ({ sceneId, durationMs: segmentMs([sceneId]) }));
      const plan = computeSocialWindowRanges(durations, source.durationMs, windowOptionsFor(source.provider));
      if (!plan || !plan.needsSecondSource || plan.uncoveredSceneIds.length === 0) return [head];
      const uncovered = new Set(plan.uncoveredSceneIds);
      const tailIds = segment.sceneIds.filter((sceneId) => uncovered.has(sceneId));
      const coveredIds = segment.sceneIds.filter((sceneId) => !uncovered.has(sceneId));
      const tailSegment: PlannedSegment = { ...segment, segmentId: `${segment.segmentId}-b`, sceneIds: tailIds, durationMs: segmentMs(tailIds) };
      try {
        const tail = await sourceOne(tailSegment, depth + 1);
        if (tail.some((piece) => !piece.source)) return [head];
        if (coveredIds.length === 0) return tail;
        return [{ ...head, segment: { ...segment, sceneIds: coveredIds, durationMs: segmentMs(coveredIds) } }, ...tail];
      } catch {
        return [head];
      }
    };
    const sourceOne = async (segment: PlannedSegment, depth: number): Promise<SourcedSegment[]> => withSecondSource(await one(segment), depth);
    const one = async (segment: PlannedSegment): Promise<SourcedSegment> => {
      let source = await this.findReusableSource(projectId, segment, input.ledger);
      let errorCode: string | null = null;
      if (!source) {
        const task = () => this.importSegmentSource(projectId, userId, role, { providerAccountId: input.providerAccountId, script: input.script, segment, ledger: input.ledger, job });
        const imported = await (input.runImport ? input.runImport(segment, task) : task());
        if (imported.ok) {
          source = imported.data;
          // Refine the generic reason with why extraction did not help this segment.
          if (extractionReason && source.provider === "pexels" && source.fallbackReason === "no_ja_keywords") source = { ...source, fallbackReason: extractionReason };
        } else errorCode = imported.code;
      }
      const visionSkip = job.vision.skipReasonFor(segment.sceneIds[0] ?? "");
      if (source && visionSkip) source = { ...source, visionSkipped: visionSkip };
      if (source) input.ledger.add(source);
      return { segment, source, errorCode };
    };
    const worker = async () => {
      for (;;) {
        if (input.stopOnFailure && failure) return;
        const index = next++;
        if (index >= input.segments.length) return;
        const segment = input.segments[index]!;
        try {
          results[index] = await sourceOne(segment, 0);
        } catch (error) {
          if (input.stopOnFailure) {
            if (!failure || index < failure.index) failure = { index, error };
          } else {
            results[index] = [{ segment, source: null, errorCode: "PROVIDER_UNAVAILABLE" }];
          }
        }
      }
    };
    const width = Math.max(1, Math.min(input.concurrency ?? MEDIA_PLAN_SOURCING_CONCURRENCY, input.segments.length || 1));
    await Promise.all(Array.from({ length: width }, () => worker()));
    const u = job.usage;
    const touched = u.runs > 0 || u.searchesReused > 0 || u.libraryReuses > 0;
    const failed = failure as { index: number; error: unknown } | null;
    return {
      sourced: results.flatMap((entry) => entry ?? []),
      failure: failed ? { segment: input.segments[failed.index]!, error: failed.error } : null,
      visionUsage: job.vision.usage(),
      apifyUsage: touched ? { runs: u.runs, seconds: u.seconds, usd: u.usd, searchesReused: u.searchesReused, libraryReuses: u.libraryReuses } : null,
    };
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
      let socialWindow: { needsSecondSource: boolean; coveredMs: number } | null = null;
      if (source) {
        const sceneDurations = segment.sceneIds.map((sceneId) => {
          const scene = script.scenes.find((s) => s.sceneId === sceneId);
          return { sceneId, durationMs: scene ? sceneDuration(scene) : 1 };
        });
        ranges = null;
        if (source.kind === "video") {
          // Non-looping, contiguous window for EVERY video source (social clips keep their intro/outro guards, stock clips none): a
          // clip that cannot cover all scenes is flagged for a second source (see withSecondSource) instead of silently replaying
          // its opening seconds in a later scene. Only an unknown duration falls back to the legacy looping layout.
          const plan = computeWindowRangesWithLoopFallback(sceneDurations, source.durationMs, windowOptionsFor(source.provider));
          if (plan) {
            ranges = plan.ranges;
            socialWindow = { needsSecondSource: plan.needsSecondSource, coveredMs: plan.coveredMs };
          } else {
            ranges = computeSegmentSourceRanges(sceneDurations, source.durationMs);
          }
        }
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
        ...(socialWindow ?? {}),
        ...(source?.provider ? { sourceProvider: source.provider } : {}),
        ...(source?.fallbackReason ? { fallbackReason: source.fallbackReason } : {}),
        ...(source?.apifyProvenance ? { apifyProvenance: source.apifyProvenance } : {}),
        ...(source?.apifyQuality ? { apifyQuality: source.apifyQuality } : {}),
        ...(source?.visionSkipped ? { visionSkipped: source.visionSkipped } : {}),
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
    const { sourced, apifyUsage, visionUsage } = await this.sourceSegments(projectId, userId, role, { providerAccountId: input.providerAccountId, script: planScript, segments: this.planSegments(planScript, range), ledger, beforeSourcing: (pending) => this.extractKeywordsForStudio(userId, role, planScript, pending) });
    const built = this.buildBindings(planScript, sourced);
    return {
      ok: true,
      data: {
        policyVersion: MEDIA_PLAN_POLICY_VERSION,
        range,
        scenes: built.scenes.map(({ mediaKind: _mediaKind, ...scene }) => scene),
        segments: built.segments,
        diagnostics: built.diagnostics,
        ...(apifyUsage ? { apifyUsage } : {}),
        ...(visionUsage ? { visionUsage } : {}),
      },
    };
  }
}
