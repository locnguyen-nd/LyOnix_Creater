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
  findFreeWindow,
  kenBurnsFor,
  parseSegmentKeywords,
  mediaSegmentDeadlineMs,
  raceByPriority,
  applySubjectToBrief,
  subjectNames,
  subjectProfileOf,
  subjectShareTargetFromEnv,
  subjectTierKeywords,
  anchorKeywordToSubject,
  type ClipWindow,
  type DegradedTier,
  type KenBurnsPlan,
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
import { ProviderError, isValidJaSearchKeyword, normalizePexelsQuery, normalizeScriptVisualPlanV2 } from "@lyonix/providers";
import { getSharedProviderLimiter } from "./concurrency-config.js";
import { isApifyPlatform, type ApifyPlatform } from "@lyonix/providers";
import { createHash, randomUUID } from "node:crypto";
import { BRAND_BACKGROUND_HEIGHT, BRAND_BACKGROUND_WIDTH, brandBackgroundColorFromEnv, buildBrandBackgroundPng } from "./brand-background.js";
import { MediaLibraryService, libraryL0Enabled } from "./media-library.service.js";
import { MediaService } from "./media.service.js";
import { writeQuarantineFile } from "./quarantine.js";
import { ScriptGenerationService } from "./script-generation.service.js";
import { ApifyJobContext, ApifyService } from "./apify.service.js";
import { GrantsService } from "./grants.service.js";
import { PexelsService } from "./pexels.service.js";
import { socialFetchEnabled } from "./social-fetch.service.js";
import { SocialSourceService, socialLedgerIdFromFileName } from "./social-source.service.js";
import { PrismaService } from "./prisma.service.js";

export type MediaPlanOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; /** VE2E-130: per-tier reasons the primary sourcing found nothing (feeds the degraded ladder). */ reasons?: string };

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
  provider?: "apify" | "pexels" | "social";
  /** VE2E-46: recorded when Apify was tried/skipped and the source came from the Pexels fallback. */
  fallbackReason?: string | null;
  apifyProvenance?: MediaPlanSegmentDiagnostics["apifyProvenance"];
  /** VE2E-51: candidate filtering / two-phase details of the Apify attempt (kept when it fell back to Pexels). */
  apifyQuality?: MediaPlanApifyQuality | null;
  /** VE2E-57: vision moderation was skipped for this segment (budget spent or model cooling down); metadata-only ranking decided. */
  visionSkipped?: "vision_skipped_budget" | "vision_skipped_quota";
  /** VE2E-130: search tier that produced this (non-degraded) source. */
  tier?: "ja" | "en" | "broad" | "pexels" | "library" | "shorts" | "gallery" | "clip";
  /** VE2E-135 (L0): match score of a prepared-library clip (`tier: "library"`). */
  libraryScore?: number;
  /** VE2E-130: ladder level L4-L6 (flagged `quality_degraded`); absent = a normal source. */
  degraded?: DegradedTier;
  /** VE2E-130 (L4): the window of the (shared) clip this segment uses; ranges are laid out inside it. */
  window?: { startMs: number; durationMs: number };
  /** VE2E-130 (L5): pan/zoom for a still image; consumed by render/media-worker. */
  kenBurns?: KenBurnsPlan;
  /** VE2E-130 (L6): generated flat brand background, not footage. */
  placeholder?: boolean;
  /** VE2E-130: why the primary tiers found nothing (only set on degraded sources). */
  degradeReason?: string | null;
};

export type SourcedSegment = { segment: PlannedSegment; source: SegmentSource | null; errorCode: string | null };

const plainExternalId = (id: string) => (id.startsWith("apify:") || id.startsWith("social:") ? id.split(":").slice(2).join(":") : id);

/** Tracks what earlier segments of one plan already used - a new segment must never pick any of these. */
export class SegmentSourceLedger {
  /** VE2E-135: identity of this video (job) for the library repeat window. */
  readonly jobKey = randomUUID();
  readonly externalIds = new Set<string>();
  readonly assetIds = new Set<string>();
  /**
   * VE2E-51: plain platform video ids (`apify:tiktok:<id>` -> `<id>`), a LIVE set shared with `ApifyService.autoImportForSegment`,
   * which reserves the chosen id in it before any await so concurrently sourced segments cannot pick the same clip.
   */
  readonly apifyPlainIds = new Set<string>();
  /** VE2E-130 (L4): video clips already chosen in this job, by asset id, with the windows other segments occupy. */
  kenBurnsCount = 0;
  /** VE2E-89: authors of the social clips chosen so far (light cross-segment coherence in the ranking). */
  readonly authors = new Set<string>();
  readonly clips = new Map<string, { durationMs: number; provider: "apify" | "pexels" | "social" | undefined; windows: ClipWindow[]; /** VE2E-136: normalised subjects of the segments that took a window of this clip (same-subject segments may take another window instead of a new search). Lost in the dev merge of VE2E-136 + VE2E-147, restored. */ subjects: Set<string> }>();
  add(source: SegmentSource) {
    this.assetIds.add(source.mediaAssetVersionId);
    if (source.apifyProvenance?.author) this.authors.add(source.apifyProvenance.author);
    if (source.externalId) {
      this.externalIds.add(source.externalId);
      this.apifyPlainIds.add(plainExternalId(source.externalId));
    }
  }
  /** Releases a live reservation (Apify/Pexels id picked by a tier that lost the race) unless a segment really committed it. */
  release(plainId: string | null | undefined) {
    if (!plainId) return;
    const committed = [...this.externalIds].some((id) => plainExternalId(id) === plainId);
    if (!committed) this.apifyPlainIds.delete(plainId);
  }
}

/** VE2E-51: at most this many segments are sourced at once. */
export const MEDIA_PLAN_SOURCING_CONCURRENCY = 3;
/** Window guards per provider: social (Apify) clips skip the author's intro/outro, stock (Pexels) clips are used from the first frame to the last. */
const windowOptionsFor = (provider: string | undefined) => (provider === "apify" || provider === "social" ? socialWindowOptionsFromEnv() : { startGuardMs: 0, endGuardMs: 0 });
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

/** Platforms for VIDEO slots, in order: env `APIFY_VIDEO_PLATFORMS` (alias `APIFY_AUTO_PLATFORMS`; legacy single `APIFY_AUTO_PLATFORM`), default TikTok then X (the next platform is searched only when the previous one yields no usable clip). Image-only platforms are never used for a video slot. */
export const apifyAutoPlatformsFromEnv = (): ApifyPlatform[] => {
  const raw = process.env.APIFY_VIDEO_PLATFORMS ?? process.env.APIFY_AUTO_PLATFORMS;
  if (raw !== undefined) return parsePlatformList(raw, VIDEO_PLATFORMS, ["tiktok", "x"]);
  return process.env.APIFY_AUTO_PLATFORM ? [apifyAutoPlatformFromEnv()] : ["tiktok", "x"];
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
  return parseSegmentKeywords(segment.keywords).ja.find((candidate) => isValidJaSearchKeyword(candidate)) ?? null;
};

/** Segments that would be sent to Apify without a valid ja keyword (plan missing or the ja keyword failed validation): input of the dedicated keyword extraction. */
export const segmentsNeedingKeywords = (segments: readonly PlannedSegment[]): PlannedSegment[] =>
  segments.filter((segment) => apifyKeywordForSegment(segment) === null && parseSegmentKeywords(segment.keywords).en.length === 0);

/** Narration of a segment's scenes in script order (the only text the keyword extraction sees). */
export const segmentNarration = (script: MediaPlanScript, segment: PlannedSegment): string =>
  segment.sceneIds.map((sceneId) => script.scenes.find((scene) => scene.sceneId === sceneId)?.narration.trim() ?? "").filter(Boolean).join(" ");

/** Applies extracted keywords to the planned segments in place; `en` from the plan wins, extracted `en` only fills a gap. */
export const applyExtractedKeywords = (segments: readonly PlannedSegment[], extracted: Readonly<Record<string, { ja: string; en: string }>>): void => {
  for (const segment of segments) {
    const found = extracted[segment.segmentId];
    if (!found || !isValidJaSearchKeyword(found.ja)) continue;
    // `en` from the plan wins (legacy string or VE2E-88 list); other tier fields of the new format are kept.
    segment.keywords = { ...(segment.keywords as object | null), ja: found.ja.trim(), en: parseSegmentKeywords(segment.keywords).en[0] || found.en.trim() };
  }
};

const normalizeSubjectKey = (subject: string | null | undefined): string => (subject ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Env `CLIP_WINDOW_REUSE` (default on): a segment whose subject already has a clip in this job takes another free window of it before any new search. */
const clipWindowReuseEnabled = () => !/^(0|false|off|no)$/i.test(process.env.CLIP_WINDOW_REUSE ?? "");

/**
 * Same-subject window reuse: one downloaded clip often holds far more footage than the segment that chose it used. A later segment
 * about the same subject claims a free, long-enough window of that clip (synchronously, so parallel segments never share one) instead
 * of paying for another search + download. Not a degraded source: the clip already passed the relevance filters for this subject.
 */
export function claimSameSubjectWindow(ledger: SegmentSourceLedger, segment: PlannedSegment): SegmentSource | null {
  const subject = normalizeSubjectKey(segment.subject);
  if (!subject || !clipWindowReuseEnabled()) return null;
  const candidates = [...ledger.clips].filter(([, clip]) => clip.subjects.has(subject));
  const pick = findFreeWindow(candidates.map(([id, clip]) => ({ id, durationMs: clip.durationMs, usedWindows: clip.windows, ...windowOptionsFor(clip.provider) })), segment.durationMs, { minPartialRatio: 1 });
  if (!pick || !pick.full) return null;
  const clip = ledger.clips.get(pick.clipId)!;
  clip.windows.push({ startMs: pick.startMs, endMs: pick.startMs + pick.durationMs });
  return { mediaAssetVersionId: pick.clipId, kind: "video", durationMs: clip.durationMs, externalId: null, sourcing: "reused", ...(clip.provider ? { provider: clip.provider } : {}), tier: "clip", window: { startMs: pick.startMs, durationMs: pick.durationMs } };
}

/** L4 bookkeeping: remember a chosen video clip and the window of it this segment occupies, so another segment can use a different one. */
const registerClipWindow = (ledger: SegmentSourceLedger, source: SegmentSource, segment: PlannedSegment, scenes: MediaPlanScene[]) => {
  if (source.kind !== "video" || source.degraded || source.window || !source.durationMs || source.durationMs <= 0) return;
  const plan = computeWindowRangesWithLoopFallback(scenes, source.durationMs, windowOptionsFor(source.provider));
  const starts = plan?.ranges.map((range) => range.sourceStartMs) ?? [];
  const ends = plan?.ranges.map((range) => range.sourceStartMs + range.sourceDurationMs) ?? [];
  const window = plan && starts.length > 0 ? { startMs: Math.min(...starts), endMs: Math.max(...ends) } : { startMs: 0, endMs: Math.min(segment.durationMs, source.durationMs) };
  const clip = ledger.clips.get(source.mediaAssetVersionId) ?? { durationMs: source.durationMs, provider: source.provider, windows: [] as ClipWindow[], subjects: new Set<string>() };
  clip.windows.push(window);
  const subject = normalizeSubjectKey(segment.subject);
  if (subject) clip.subjects.add(subject);
  ledger.clips.set(source.mediaAssetVersionId, clip);
};

/** Primary Pexels tier queries (en, broad), both anchored on the video subject; empty = keep the brief's own phrase. At most 2 tries. */
const pexelsSubjectQueries = (segment: PlannedSegment): string[] => {
  const profile = subjectProfileOf(segment);
  if (subjectNames(profile).length === 0) return [];
  const keywords = parseSegmentKeywords(segment.keywords);
  return [...new Set([keywords.en[0], keywords.broad[0], profile.subject].filter((value): value is string => Boolean(value)).map((value) => anchorKeywordToSubject(value, profile, "en")))].slice(0, 2);
};

const searchable = (value: string | null | undefined): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Pexels queries of one segment, never empty strings: the caller's subject-bound queries, else the first non-empty of the brief's
 * phrases, the segment scenes' visual queries, its en / broad keywords, mood and subject. `[]` = nothing searchable (skip the tier).
 */
export function pexelsQueriesFor(given: readonly string[] | undefined, phrases: readonly string[], script: MediaPlanScript, segment: PlannedSegment): string[] {
  const explicit = (given ?? []).map(normalizePexelsQuery).filter(searchable);
  if (explicit.length > 0) return explicit;
  const keywords = parseSegmentKeywords(segment.keywords);
  const sceneQueries = segment.sceneIds.map((sceneId) => script.scenes.find((scene) => scene.sceneId === sceneId)?.visualQuery);
  const fallback = [...phrases, ...sceneQueries, ...keywords.en, ...keywords.broad, keywords.mood, segment.subject].find(searchable);
  return fallback ? [normalizePexelsQuery(fallback)] : [];
}

/** L5 stock-photo queries: subject-bound keywords first (en, broad, subject), the generic `mood` only as the last resort; at most 2 tries (Pexels is fast but metered). */
const stockImageQueries = (segment: PlannedSegment): string[] => {
  const keywords = parseSegmentKeywords(segment.keywords);
  const profile = subjectProfileOf(segment);
  const bound = [keywords.en[0], keywords.broad[0], segment.subject?.trim()].filter((value): value is string => Boolean(value)).map((value) => anchorKeywordToSubject(value, profile, "en"));
  return [...new Set([...bound, keywords.mood].filter((value): value is string => Boolean(value)))].slice(0, 2);
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
    /** VE2E-130: registers the L6 brand-background placeholder asset. Absent = L6 unavailable (L4/L5 still apply). */
    @Optional() @Inject(MediaService) private readonly media?: MediaService,
    /** VE2E-135: prepared media library (ladder L0 + tags on import). Absent = no L0, unchanged behaviour. */
    @Optional() @Inject(MediaLibraryService) private readonly library?: MediaLibraryService,
    /** VE2E-147/148: yt-dlp / gallery-dl tiers (YouTube Shorts, Pinterest/X). Absent or switched off (env) = unchanged ladder. */
    @Optional() @Inject(SocialSourceService) private readonly social?: SocialSourceService,
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
    if (await this.resolvePexelsAccountId(userId, role, mediaAccountId).then((id) => id !== null && id !== mediaAccountId)) return { ok: true };
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
    // VE2E-88/89: weighted allocation so the main subject gets its share (env SUBJECT_SHARE_TARGET, default 0.6).
    return planBackgroundSegments(scenes, script.visualPlan, range, { subjectShareTarget: subjectShareTargetFromEnv() });
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
    const externalId = pexelsExternalIdFromFileName(row.originalFileName) ?? apifyLedgerIdFromFileName(row.originalFileName) ?? socialLedgerIdFromFileName(row.originalFileName);
    if (ledger.assetIds.has(row.id) || (externalId && ledger.externalIds.has(externalId))) return null;
    return { mediaAssetVersionId: row.id, kind: row.kind, durationMs: row.durationMs, externalId, sourcing: "reused", ...(row.origin === "apify" ? { provider: "apify" as const } : row.origin === "social" ? { provider: "social" as const } : {}) };
  }

  /**
   * The segment's search brief: the first scene's narrative-beat brief (VE2E-15a), led by the
   * segment's `keywords.en` when the plan has one (Pexels indexes English best; `keywords.ja` is kept
   * on the timeline segment for the future Apify source, VE2E-34), and targeting the WHOLE segment's
   * duration so ranking prefers clips long enough to run across all its scenes.
   */
  segmentBrief(script: MediaPlanScript, segment: PlannedSegment, ledger?: SegmentSourceLedger): SceneBrief {
    const firstIndex = Math.max(0, script.scenes.findIndex((scene) => scene.sceneId === segment.sceneIds[0]));
    const brief = deriveSceneBrief({ language: script.language, scenes: script.scenes.map((scene) => ({ ...scene, durationHintMs: sceneDuration(scene) })) }, firstIndex);
    const english = parseSegmentKeywords(segment.keywords).en[0];
    const phrases = english ? [english, ...brief.phrases.filter((phrase) => phrase.trim().toLowerCase() !== english.toLowerCase())].slice(0, MAX_QUERY_VARIANTS) : brief.phrases;
    // VE2E-89: subject aliases (ranking bonus), mustExclude (hard filter), subject in the vision entities only for the main-subject segment.
    return applySubjectToBrief({ ...brief, phrases, targetDurationSeconds: segment.durationMs / 1000 }, subjectProfileOf(segment), { priority: segment.priority, ...(ledger ? { preferredAuthors: [...(ledger.authors ?? [])] } : {}) });
  }

  /**
   * VE2E-130 (CR-MEDIA-SLA §2.5): the Pexels account to use as the stock source. The job's chosen media account when it is an enabled,
   * verified Pexels account; otherwise ANY verified Pexels account the user can see (the profile's media account is often Apify, which
   * used to leave the segment without a stock fallback). Unknown/mock environments count the chosen id as usable. `null` = none.
   */
  async resolvePexelsAccountId(userId: string, role: "admin" | "staff", preferredId: string): Promise<string | null> {
    try {
      const row = await this.prisma.providerAccount.findFirst({ where: { id: preferredId, deletedAt: null }, select: { provider: true, enabled: true, status: true, isFake: true } });
      if (!row) return preferredId;
      if (row.provider === "pexels" && row.enabled !== false && (row.isFake ? process.env.NODE_ENV === "test" : row.status === "verified")) return preferredId;
    } catch {
      return preferredId;
    }
    try {
      const rows = await this.prisma.providerAccount.findMany({
        where: {
          provider: "pexels",
          deletedAt: null,
          enabled: true,
          ...(process.env.NODE_ENV === "test" ? {} : { status: "verified", isFake: false }),
          ...(role === "admin" ? {} : { OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: userId }] }),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: 1,
      });
      return rows[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  private async findApifyAccount(userId: string, role: "admin" | "staff"): Promise<{ id: string; encryptedSecret: string } | null> {
    if (!this.apify) return null;
    try {
      return await this.apify.findAccountForUser(userId, role);
    } catch {
      return null;
    }
  }

  /**
   * One Apify search tier (VE2E-130): exactly ONE `autoImportForSegment` call (search + at most one download) on the first configured
   * platform, with this tier's keyword. `ja` is the strict pass; `en`/`broad` use the relaxed filter. The apify limiter is applied
   * INSIDE ApifyService around each Actor call (VE2E-131: this task depends on it), no longer around the whole segment here. Never throws.
   */
  private async apifyTier(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { script: MediaPlanScript; segment: PlannedSegment; ledger: SegmentSourceLedger; job?: ApifyJobContext; allowUnverified: boolean; tier: "ja" | "en" | "broad"; keyword: string; account: { id: string; encryptedSecret: string } },
  ): Promise<{ source: SegmentSource } | { reason: string; quality: MediaPlanApifyQuality | null }> {
    try {
      const brief = this.segmentBrief(input.script, input.segment, input.ledger);
      const visualKind = segmentVisualKind(input.segment);
      const platform = (visualKind === "image" ? apifyImagePlatformsFromEnv() : apifyAutoPlatformsFromEnv())[0] ?? "tiktok";
      // Live set (VE2E-51): ApifyService reserves the chosen video id in it so segments/tiers run in parallel never share a clip.
      const usedExternalIds = input.ledger.apifyPlainIds;
      const attempt = await this.apify!.autoImportForSegment(projectId, userId, role, input.account, {
        platform,
        mediaType: visualKind,
        keyword: input.keyword,
        brief: { ...brief, phrases: [input.keyword, ...brief.phrases.filter((phrase) => phrase !== input.keyword)].slice(0, MAX_QUERY_VARIANTS) },
        sceneId: input.segment.sceneIds[0]!,
        usedExternalIds,
        scriptLanguage: input.script.language,
        segmentDurationSeconds: input.segment.durationMs / 1000,
        ...(input.allowUnverified ? { allowUnverified: true } : {}),
        // The degraded ladder (L4-L6) now guarantees a source, so only the relaxed tiers accept a flagged overlay / below-threshold clip.
        // VE2E-131/89: the en/broad tiers search with the English keyword and the loosened en filter (no `lenient` any more), bound to the subject aliases.
        ...(input.tier !== "ja" ? { keepOverlayFlagged: true, lang: "en" as const } : {}),
        ...(subjectNames(subjectProfileOf(input.segment)).length > 0 ? { subjectAliases: subjectNames(subjectProfileOf(input.segment)) } : {}),
        ...(input.job ? { job: input.job } : {}),
      });
      if (!attempt.ok) return { reason: attempt.reason, quality: attempt.quality ?? null };
      const asset = attempt.data.asset;
      if ((asset.kind !== "video" && asset.kind !== "image") || input.ledger.assetIds.has(asset.id) || input.ledger.externalIds.has(attempt.data.ledgerId)) {
        // Release the reservation made by ApifyService (the ledger itself never held this clip).
        if (!input.ledger.externalIds.has(attempt.data.ledgerId)) usedExternalIds.delete(attempt.data.externalId);
        return { reason: "apify_duplicate_or_unsupported_source", quality: attempt.data.quality };
      }
      const provenance = attempt.data.provenance;
      return {
        source: {
          mediaAssetVersionId: asset.id,
          kind: asset.kind,
          durationMs: asset.durationMs,
          externalId: attempt.data.ledgerId,
          sourcing: "imported",
          provider: "apify",
          tier: input.tier,
          apifyProvenance: provenance ? { platform: provenance.platform, actorId: provenance.actorId, actorVersion: provenance.actorVersion, sourceUrl: provenance.sourceUrl, author: provenance.author, fetchedAt: provenance.fetchedAt } : null,
          apifyQuality: attempt.data.quality,
        },
      };
    } catch (error) {
      if (error instanceof ProviderError && error.code === "PROVIDER_RATE_LIMITED") return { reason: "apify_queue_timeout", quality: null };
      return { reason: "apify_error:unexpected", quality: null };
    }
  }

  /**
   * VE2E-147/148: an open-source social tier. `shorts` = YouTube Shorts (yt-dlp search + download) for video slots, `gallery` =
   * Pinterest (or X) via gallery-dl for image slots. Same ledger rules as the Apify tiers (live claim set, never a used asset/id).
   */
  private async socialTier(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { segment: PlannedSegment; ledger: SegmentSourceLedger; tier: "shorts" | "gallery"; queries: string[] },
  ): Promise<{ source: SegmentSource } | { reason: string }> {
    try {
      const mediaType = input.tier === "gallery" ? "image" : "video";
      const galleryPlatform = (process.env.MEDIA_GALLERY_PLATFORM ?? "").trim().toLowerCase() === "x" ? "x" : "pinterest";
      const keywords = parseSegmentKeywords(input.segment.keywords);
      const attempt = await this.social!.autoImportForSegment(projectId, userId, role, {
        platform: input.tier === "shorts" ? "youtube" : galleryPlatform,
        tool: input.tier === "shorts" ? "yt-dlp" : "gallery-dl",
        queries: input.queries,
        mediaType,
        segmentDurationSeconds: input.segment.durationMs / 1000,
        usedExternalIds: input.ledger.apifyPlainIds,
        subjectAliases: subjectNames(subjectProfileOf(input.segment)),
        keywords: [...keywords.ja, ...keywords.en],
        sceneId: input.segment.sceneIds[0]!,
      });
      if (!attempt.ok) return { reason: attempt.reason };
      const asset = attempt.data.asset;
      if (input.ledger.assetIds.has(asset.id) || input.ledger.externalIds.has(attempt.data.ledgerId)) {
        if (!input.ledger.externalIds.has(attempt.data.ledgerId)) input.ledger.apifyPlainIds.delete(attempt.data.externalId);
        return { reason: "social_duplicate_source" };
      }
      return {
        source: {
          mediaAssetVersionId: asset.id,
          kind: asset.kind,
          durationMs: asset.durationMs,
          externalId: attempt.data.ledgerId,
          sourcing: attempt.data.reused ? "reused" : "imported",
          provider: "social",
          tier: input.tier,
        },
      };
    } catch {
      return { reason: "social_error:unexpected" };
    }
  }

  /**
   * The Pexels stock tier. No per-plan mutex (VE2E-130): the chosen id is claimed in the live ledger set in the same tick it is known
   * (no await between the check and the claim), and a clash with a segment that claimed it first retries once with that id excluded.
   */
  private async pexelsTier(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { script: MediaPlanScript; segment: PlannedSegment; ledger: SegmentSourceLedger; job?: ApifyJobContext; pexelsAccountId: string; mediaType?: "video" | "image"; queries?: string[] },
  ): Promise<MediaPlanOutcome<SegmentSource>> {
    const brief = this.segmentBrief(input.script, input.segment, input.ledger);
    const excluded = new Set<string>();
    const queries = pexelsQueriesFor(input.queries, brief.phrases, input.script, input.segment);
    // Pexels answers an empty query with 400 ("No query param given"): never send one - the segment simply has no searchable words.
    if (queries.length === 0) {
      if (process.env.NODE_ENV !== "test") console.info(`[pexels] ${input.segment.segmentId}: skipped, no searchable keyword (never sends an empty query)`);
      return { ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "Không có từ khoá để tìm trên Pexels (no_query)", status: 422 };
    }
    const mediaType = input.mediaType ?? input.segment.visualKind;
    let last: MediaPlanOutcome<SegmentSource> = { ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "Pexels không có nguồn phù hợp.", status: 422 };
    for (const query of queries) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sceneBrief = input.queries ? { ...brief, phrases: [query, ...brief.phrases.filter((phrase) => phrase !== query)].slice(0, MAX_QUERY_VARIANTS) } : brief;
        const outcome = await getSharedProviderLimiter().run("pexels", () => this.pexels.autoImportForScene(projectId, userId, role, {
          providerAccountId: input.pexelsAccountId,
          sceneId: input.segment.sceneIds[0]!,
          query,
          sceneBrief,
          usedExternalIds: [...new Set([...input.ledger.externalIds, ...input.ledger.apifyPlainIds, ...excluded])],
          // Template-aware sourcing: an image slot gets a photo, a video slot a video (no cross-kind fallback). Unknown kind = legacy.
          ...(mediaType ? { mediaType } : {}),
          ...(input.job ? { visionBudget: input.job.vision } : {}),
        }));
        if (!outcome.ok) { last = outcome; break; }
        const asset = outcome.data.asset;
        if (asset.kind !== "video" && asset.kind !== "image") return { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: `Asset Pexels vừa import có kind không hỗ trợ: ${asset.kind}` };
        const externalId = outcome.data.externalId;
        if (input.ledger.assetIds.has(asset.id) || input.ledger.externalIds.has(externalId) || input.ledger.apifyPlainIds.has(externalId)) {
          // Same bytes/id as a source another segment already holds (or claimed a moment ago): exclude it and ask once more.
          excluded.add(externalId);
          last = { ok: false, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "Nguồn tìm được trùng với nguồn của segment khác; cần chọn thủ công trong Studio.", status: 422 };
          continue;
        }
        input.ledger.apifyPlainIds.add(externalId); // claim (live set), same tick as the check above
        return { ok: true, data: { mediaAssetVersionId: asset.id, kind: asset.kind, durationMs: asset.durationMs, externalId, sourcing: "imported", provider: "pexels", tier: "pexels" } };
      }
    }
    return last;
  }

  /**
   * Primary sourcing of one segment (VE2E-130, ladder L1-L3): the ja / en / broad Apify searches and the Pexels search start
   * CONCURRENTLY under one deadline (`MEDIA_SEGMENT_DEADLINE_MS`, default 75 s); the winner is picked by priority ja > en > broad > Pexels
   * (as soon as every higher tier finished, or at the deadline). At most 3 searches + 1 download per segment, no repeated lenient pass.
   * `ok: false` is NOT a failed job: Auto continues down the degraded ladder (`resolveDegradedSource`, L4-L6).
   */
  async importSegmentSource(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; script: MediaPlanScript; segment: PlannedSegment; ledger: SegmentSourceLedger; job?: ApifyJobContext },
  ): Promise<MediaPlanOutcome<SegmentSource>> {
    // L0 (VE2E-135): the prepared library answers first (< 1 s); empty/untagged/no match falls straight through to the tiers below.
    if (this.library && libraryL0Enabled()) {
      const hit = await this.library.findForSegment(projectId, input.segment, input.ledger);
      if (hit) {
        return { ok: true, data: { mediaAssetVersionId: hit.assetId, kind: "video", durationMs: hit.durationMs, externalId: hit.externalId, sourcing: "reused", ...(hit.provider ? { provider: hit.provider } : {}), tier: "library", libraryScore: hit.score } };
      }
    }
    const tierKeywords = this.apify ? subjectTierKeywords(input.segment.keywords, subjectProfileOf(input.segment), isValidJaSearchKeyword, input.segment.subject) : [];
    // The Apify account is only looked up when at least one tier has a keyword to search.
    const [pexelsAccountId, account] = await Promise.all([this.resolvePexelsAccountId(userId, role, input.providerAccountId), tierKeywords.length > 0 ? this.findApifyAccount(userId, role) : Promise.resolve(null)]);
    const reasons: Partial<Record<"ja" | "en" | "broad" | "pexels" | "shorts" | "gallery", string>> = {};
    const qualities: Partial<Record<"ja" | "en" | "broad", MediaPlanApifyQuality | null>> = {};
    const settled = new Set<string>();
    const tiers: Array<{ name: "ja" | "en" | "broad" | "pexels" | "shorts" | "gallery"; run: () => Promise<SegmentSource | null> }> = [];
    const holder: { pexelsFailure: MediaPlanOutcome<SegmentSource> | null } = { pexelsFailure: null };
    if (this.apify) {
      if (!tierKeywords.some((entry) => entry.tier === "ja")) reasons.ja = "no_ja_keywords";
      if (tierKeywords.length > 0 && !account) reasons.ja = "no_apify_account";
      else if (account) {
        for (const { tier, keyword } of tierKeywords) {
          tiers.push({
            name: tier,
            run: async () => {
              const attempt = await this.apifyTier(projectId, userId, role, { script: input.script, segment: input.segment, ledger: input.ledger, ...(input.job ? { job: input.job } : {}), allowUnverified: !pexelsAccountId, tier, keyword, account });
              if ("source" in attempt) return attempt.source;
              reasons[tier] = attempt.reason;
              qualities[tier] = attempt.quality;
              return null;
            },
          });
        }
      }
    }
    // VE2E-147/148: open-source social tiers, priority ja > en > shorts > broad > gallery > Pexels (index order = race priority).
    if (this.social) {
      const subjectKeywords = subjectTierKeywords(input.segment.keywords, subjectProfileOf(input.segment), isValidJaSearchKeyword, input.segment.subject);
      const queries = [...subjectKeywords.filter((k) => k.tier === "ja"), ...subjectKeywords.filter((k) => k.tier === "en")].map((k) => k.keyword);
      const visualKind = segmentVisualKind(input.segment);
      const want: "shorts" | "gallery" | null = visualKind === "image" ? (socialFetchEnabled("gallery") ? "gallery" : null) : socialFetchEnabled("youtube_shorts") ? "shorts" : null;
      if (want && queries.length === 0) reasons[want] = "no_keywords";
      else if (want) {
        const entry = {
          name: want,
          run: async () => {
            const attempt = await this.socialTier(projectId, userId, role, { segment: input.segment, ledger: input.ledger, tier: want, queries });
            if ("source" in attempt) return attempt.source;
            reasons[want] = attempt.reason;
            return null;
          },
        };
        const before = tiers.findIndex((tier) => (want === "shorts" ? tier.name === "broad" : false));
        if (before >= 0) tiers.splice(before, 0, entry);
        else tiers.push(entry);
      }
    }
    if (pexelsAccountId) {
      tiers.push({
        name: "pexels",
        run: async () => {
          const queries = pexelsSubjectQueries(input.segment);
          const outcome = await this.pexelsTier(projectId, userId, role, { script: input.script, segment: input.segment, ledger: input.ledger, ...(input.job ? { job: input.job } : {}), pexelsAccountId, ...(queries.length > 0 ? { queries } : {}) });
          if (outcome.ok) return outcome.data;
          holder.pexelsFailure = outcome;
          reasons.pexels = outcome.code;
          return null;
        },
      });
    }
    const winner = await raceByPriority(
      tiers.map((tier) => async () => {
        try {
          return await tier.run();
        } finally {
          settled.add(tier.name);
        }
      }),
      mediaSegmentDeadlineMs(),
      (_index, source) => input.ledger.release(source.externalId ? plainExternalId(source.externalId) : null),
    );
    for (const tier of tiers) if (!settled.has(tier.name)) reasons[tier.name] = "segment_deadline";
    const reasonText = (["ja", "en", "shorts", "broad", "gallery", "pexels"] as const).filter((name) => reasons[name]).map((name) => `${name}:${reasons[name]}`).join("; ");
    if (winner) {
      const source = winner.value;
      await this.tagImportedSource(input.segment, source);
      if (source.provider !== "pexels") return { ok: true, data: source };
      const apifyQuality = qualities.ja ?? qualities.en ?? qualities.broad ?? null;
      return { ok: true, data: { ...source, fallbackReason: reasons.ja ?? reasons.en ?? reasons.broad ?? null, ...(apifyQuality ? { apifyQuality } : {}) } };
    }
    if (holder.pexelsFailure && !holder.pexelsFailure.ok && tiers.length === 1) return { ...holder.pexelsFailure, reasons: reasonText };
    return {
      ok: false,
      code: "MEDIA_RELEVANCE_BELOW_THRESHOLD",
      message: `Không tìm được nguồn phù hợp cho đoạn ${input.segment.segmentId} (${reasonText || "không rõ lý do"})${pexelsAccountId ? "" : "; Pexels không dùng được làm dự phòng"}; chọn nguồn thủ công trong Studio hoặc thử lại.`,
      status: 422,
      reasons: reasonText,
    };
  }

  /** VE2E-135: tags a freshly imported clip (ja/en/broad keywords, subject, aliases, source, author) so L0 can reuse it. Best effort, never throws. */
  private async tagImportedSource(segment: PlannedSegment, source: SegmentSource): Promise<void> {
    if (!this.library || source.sourcing !== "imported" || source.kind !== "video") return;
    try {
      const keywords = parseSegmentKeywords(segment.keywords);
      const profile = subjectProfileOf(segment);
      await this.library.tagAsset(source.mediaAssetVersionId, {
        ja: keywords.ja,
        en: keywords.en,
        broad: keywords.broad,
        subject: profile.subject ?? segment.subject ?? null,
        aliases: profile.aliases,
        source: source.provider ?? null,
        author: source.apifyProvenance?.author ?? null,
        externalId: source.externalId,
      });
    } catch {
      /* tagging must never fail a segment */
    }
  }

  /**
   * VE2E-130 (CR-MEDIA-SLA §3.1) degraded ladder, tried in order when the primary tiers found nothing; every result is flagged
   * `quality_degraded` (diagnostics) and the job still renders:
   *  L4 `reuse_window`: a window of a clip other segments of this job already chose that no segment uses (claimed synchronously).
   *  L5 `stock_image`: a Pexels photo (+ Ken Burns info for the render/media-worker; no FFmpeg here).
   *  L6 `brand_background`: a flat brand-colour PNG generated in-process and registered as a `generated` placeholder asset.
   * `null` only when even L6 could not be registered (no MediaService / storage error).
   */
  async resolveDegradedSource(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; script: MediaPlanScript; segment: PlannedSegment; ledger: SegmentSourceLedger; job?: ApifyJobContext; reason?: string | null },
  ): Promise<SegmentSource | null> {
    const { ledger, segment } = input;
    const reason = input.reason ?? null;
    // L4 - no await between the search and the window claim.
    const pick = findFreeWindow(
      [...ledger.clips].map(([id, clip]) => ({ id, durationMs: clip.durationMs, usedWindows: clip.windows, ...windowOptionsFor(clip.provider) })),
      segment.durationMs,
    );
    if (pick) {
      const clip = ledger.clips.get(pick.clipId)!;
      clip.windows.push({ startMs: pick.startMs, endMs: pick.startMs + pick.durationMs });
      return { mediaAssetVersionId: pick.clipId, kind: "video", durationMs: clip.durationMs, externalId: null, sourcing: "reused", ...(clip.provider ? { provider: clip.provider } : {}), degraded: "reuse_window", window: { startMs: pick.startMs, durationMs: pick.durationMs }, degradeReason: reason };
    }
    // L5
    const pexelsAccountId = await this.resolvePexelsAccountId(userId, role, input.providerAccountId);
    if (pexelsAccountId) {
      const image = await raceByPriority(
        [
          async () => {
            try {
              const outcome = await this.pexelsTier(projectId, userId, role, { script: input.script, segment, ledger, ...(input.job ? { job: input.job } : {}), pexelsAccountId, mediaType: "image", queries: stockImageQueries(segment) });
              return outcome.ok ? outcome.data : null;
            } catch {
              return null; // a stock-image error just moves on to L6
            }
          },
        ],
        mediaSegmentDeadlineMs(),
        (_index, source) => ledger.release(source.externalId),
      );
      if (image) return { ...image.value, degraded: "stock_image", kenBurns: kenBurnsFor(ledger.kenBurnsCount++, segment.durationMs), degradeReason: reason };
    }
    // L6
    const background = await this.brandBackgroundSource(projectId, userId, role);
    return background ? { ...background, degradeReason: reason } : null;
  }

  private async brandBackgroundSource(projectId: string, userId: string, role: "admin" | "staff"): Promise<SegmentSource | null> {
    if (!this.media) return null;
    try {
      const color = brandBackgroundColorFromEnv();
      const png = buildBrandBackgroundPng(color);
      const quarantined = await writeQuarantineFile(png);
      const registered = await this.media.registerAsset(projectId, userId, role, {
        quarantineToken: quarantined.quarantineToken,
        kind: "image",
        originalFileName: `lyonix-brand-background-${color.slice(1).toLowerCase()}.png`,
        mimeType: "image/png",
        checksumSha256: createHash("sha256").update(png).digest("hex"),
        bytes: png.byteLength,
        widthPx: BRAND_BACKGROUND_WIDTH,
        heightPx: BRAND_BACKGROUND_HEIGHT,
        durationMs: null,
        origin: "generated",
        license: "LyOnix placeholder (flat brand background, not stock footage)",
        reusable: true,
        serverProvenance: { placeholder: "brand_background", qualityDegraded: true, color },
      });
      if (typeof registered === "string") return null;
      return { mediaAssetVersionId: registered.id, kind: "image", durationMs: null, externalId: null, sourcing: "imported", degraded: "brand_background", placeholder: true };
    } catch {
      return null;
    }
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
       * VE2E-53 second source for a clip whose window cannot cover every scene. Default on. The Auto runner turns it OFF for the early
       * (TTS-parallel, VE2E-133) pass that only knows `durationHintMs`: a hint above the real voice length would make clips look too short and
       * pay for needless extra sources; the post-TTS reconcile pass searches the uncovered tail with the real durations.
       */
      allowSecondSource?: boolean;
      /** Segment ids already used by pieces sourced elsewhere in the same run (e.g. reused early pieces): a second-source tail id must not collide with them. */
      reservedSegmentIds?: readonly string[];
      /**
       * VE2E-130 (Auto): the media step never fails the job. A segment the primary tiers (ja/en/broad/Pexels) cannot source - including
       * one whose `runImport` threw - falls down the degraded ladder L4 (other window of a clip of this job) -> L5 (stock image + Ken
       * Burns) -> L6 (brand background), flagged `quality_degraded`. Replaces `stopOnFailure` for Auto; implies swap-overlay policy.
       */
      guaranteeSource?: boolean;
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
    // The vision budget scales with the number of segments (default 6 calls/job starved later segments of any verification); VISION_MAX_CALLS_PER_JOB still overrides.
    const job = new ApifyJobContext(process.env.VISION_MAX_CALLS_PER_JOB ? {} : { visionMaxCalls: Math.max(6, input.segments.length * 2) });
    // VE2E-67 (CR-SUBJECT-REFRAME Q5): Auto (`stopOnFailure`) swaps a candidate whose overlay cannot be avoided; Studio only flags it.
    job.overlayPolicy = input.stopOnFailure || input.guaranteeSource ? "swap" : "flag";
    const degradeReasons = new Map<string, string>();
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
    const takenIds = new Set([...input.segments.map((item) => item.segmentId), ...(input.reservedSegmentIds ?? [])]);
    const uniqueSegmentId = (base: string): string => {
      let candidate = base;
      for (let n = 2; takenIds.has(candidate); n += 1) candidate = `${base}${n}`;
      takenIds.add(candidate);
      return candidate;
    };
    const withSecondSource = async (head: SourcedSegment, depth: number): Promise<SourcedSegment[]> => {
      const { segment, source } = head;
      if (!source || input.allowSecondSource === false || depth >= MAX_SECOND_SOURCE_SPLITS || source.kind !== "video") return [head];
      const durations = segment.sceneIds.map((sceneId) => ({ sceneId, durationMs: segmentMs([sceneId]) }));
      const plan = computeSocialWindowRanges(durations, source.durationMs, windowOptionsFor(source.provider));
      if (!plan || !plan.needsSecondSource || plan.uncoveredSceneIds.length === 0) return [head];
      const uncovered = new Set(plan.uncoveredSceneIds);
      const tailIds = segment.sceneIds.filter((sceneId) => uncovered.has(sceneId));
      const coveredIds = segment.sceneIds.filter((sceneId) => !uncovered.has(sceneId));
      const tailSegment: PlannedSegment = { ...segment, segmentId: uniqueSegmentId(`${segment.segmentId}-b`), sceneIds: tailIds, durationMs: segmentMs(tailIds) };
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
      if (!source) source = claimSameSubjectWindow(input.ledger, segment);
      if (!source) {
        const task = () => this.importSegmentSource(projectId, userId, role, { providerAccountId: input.providerAccountId, script: input.script, segment, ledger: input.ledger, job });
        const imported = await (input.runImport ? input.runImport(segment, task) : task());
        if (imported.ok) {
          source = imported.data;
          // Refine the generic reason with why extraction did not help this segment.
          if (extractionReason && source.provider === "pexels" && source.fallbackReason === "no_ja_keywords") source = { ...source, fallbackReason: extractionReason };
        } else {
          errorCode = imported.code;
          degradeReasons.set(segment.segmentId, imported.reasons ?? imported.message);
        }
      }
      const visionSkip = job.vision.skipReasonFor(segment.sceneIds[0] ?? "");
      if (source && visionSkip) source = { ...source, visionSkipped: visionSkip };
      if (source) {
        input.ledger.add(source);
        registerClipWindow(input.ledger, source, segment, segmentSceneDurations(segment));
      }
      return { segment, source, errorCode };
    };
    const segmentSceneDurations = (segment: PlannedSegment): MediaPlanScene[] =>
      segment.sceneIds.map((sceneId) => {
        const scene = input.script.scenes.find((item) => item.sceneId === sceneId);
        return { sceneId, durationMs: scene ? sceneDuration(scene) : 1 };
      });
    const worker = async () => {
      for (;;) {
        if (input.stopOnFailure && !input.guaranteeSource && failure) return;
        const index = next++;
        if (index >= input.segments.length) return;
        const segment = input.segments[index]!;
        try {
          results[index] = await sourceOne(segment, 0);
        } catch (error) {
          if (input.guaranteeSource) {
            // The step threw (e.g. runImport's StepRun failure): a missing source, not a failed job - the ladder takes over below.
            degradeReasons.set(segment.segmentId, error instanceof Error ? error.message : "unexpected_error");
            const code = (error as { code?: unknown } | null)?.code;
            results[index] = [{ segment, source: null, errorCode: typeof code === "string" ? code : "PROVIDER_UNAVAILABLE" }];
          } else if (input.stopOnFailure) {
            if (!failure || index < failure.index) failure = { index, error };
          } else {
            results[index] = [{ segment, source: null, errorCode: "PROVIDER_UNAVAILABLE" }];
          }
        }
      }
    };
    const width = Math.max(1, Math.min(input.concurrency ?? MEDIA_PLAN_SOURCING_CONCURRENCY, input.segments.length || 1));
    await Promise.all(Array.from({ length: width }, () => worker()));
    if (input.guaranteeSource) {
      // Second phase: only now do all primary results exist, so L4 sees every clip/window of the job.
      const missing = results.flatMap((entry, index) => (entry && entry.length === 1 && !entry[0]!.source ? [index] : []));
      let nextMissing = 0;
      const degradeWorker = async () => {
        for (;;) {
          const slot = nextMissing++;
          if (slot >= missing.length) return;
          const index = missing[slot]!;
          const { segment } = results[index]![0]!;
          let source: SegmentSource | null = null;
          try {
            source = await this.resolveDegradedSource(projectId, userId, role, { providerAccountId: input.providerAccountId, script: input.script, segment, ledger: input.ledger, job, reason: degradeReasons.get(segment.segmentId) ?? null });
          } catch {
            source = null;
          }
          if (source) input.ledger.add(source);
          results[index] = [{ segment, source, errorCode: source ? null : "MEDIA_PLACEHOLDER_UNAVAILABLE" }];
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(width, missing.length)) }, () => degradeWorker()));
    }
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
        if (source.kind === "video" && source.window) {
          // VE2E-130 L4: another window of a clip other segments already use; ranges are laid out inside that window (no guards).
          const offset = source.window.startMs;
          const inside = computeWindowRangesWithLoopFallback(sceneDurations, source.window.durationMs, { startGuardMs: 0, endGuardMs: 0 });
          ranges = (inside?.ranges ?? computeSegmentSourceRanges(sceneDurations, source.window.durationMs) ?? []).map((range) => ({ ...range, sourceStartMs: range.sourceStartMs + offset }));
          if (inside) socialWindow = { needsSecondSource: inside.needsSecondSource, coveredMs: inside.coveredMs };
        } else if (source.kind === "video") {
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
        ...(source?.tier ? { sourceTier: source.tier } : {}),
        ...(source?.libraryScore !== undefined ? { libraryScore: source.libraryScore } : {}),
        ...(source?.degraded
          ? {
              qualityDegraded: true,
              degradedTier: source.degraded,
              ...(source.placeholder ? { placeholder: true } : {}),
              ...(source.kenBurns ? { kenBurns: source.kenBurns } : {}),
              ...(source.window ? { reusedWindow: source.window } : {}),
              ...(source.degradeReason ? { degradeReason: source.degradeReason } : {}),
            }
          : {}),
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
    const { sourced, apifyUsage, visionUsage } = await this.sourceSegments(projectId, userId, role, { providerAccountId: input.providerAccountId, script: planScript, segments: this.planSegments(planScript, range), ledger,
      // VE2E-140: Studio auto-fill uses the same never-fails ladder as Auto (L4 other window / L5 stock photo / L6 brand background, flagged degraded),
      // so one click binds every scene instead of leaving some unbound and blocking the render (it used to need 3 clicks).
      guaranteeSource: true,
      beforeSourcing: (pending) => this.extractKeywordsForStudio(userId, role, planScript, pending) });
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
