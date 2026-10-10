/**
 * VE2E-34: Apify social/web media search + import (DEC-2026-09-29-JP-ONESHOT-MEDIA #1/#5/#10-#16).
 *
 * Search runs a PINNED allowlisted Actor on the project's verified Apify account (`searchApify`), and
 * returns candidates to the client WITHOUT any download URL: each importable candidate carries an opaque
 * `importRef` (AES-GCM sealed with the server key, bound to project + account, expiring) that the import
 * endpoint unseals. A client can therefore never make the server fetch an arbitrary URL, and the Apify
 * token / Key-Value-Store URL never leave the server.
 *
 * Import downloads through `fetchBinarySafely` with the per-platform host allowlist (whole DNS labels,
 * re-checked on every redirect), or - for Google image only - public-web mode (private/loopback/link-local
 * blocked, DNS pinned, redirects revalidated, size + image-MIME limits), sniffs the bytes, then registers a
 * `MediaAssetVersion` with `origin: "apify"` and full provenance. Audio is always stripped later by the
 * derivative cut (`decideStripAudio`, VE2E-37).
 *
 * No FFmpeg here; results/runs are bounded (<=20 items, 120 s, 1 retry) inside the adapter. A per
 * (project, platform) single-flight guard and a result cache (24 h search-only, 15 min with download links) avoid paying twice for the same query.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  APIFY_DOWNLOAD_RUN_TIMEOUT_SECS,
  APIFY_HOST_ALLOWLIST,
  APIFY_MAX_BATCH_POSTS,
  ProviderError,
  addApifyUsage,
  emptyApifyUsage,
  fetchApifyConcurrencyLimit,
  fetchApifyTikTokPost,
  fetchApifyTikTokPosts,
  hostMatchesSuffix,
  isLiveContentKind,
  isApifyPlatform,
  searchApify,
  type ApifyUsage,
  type ApifyCandidateResult,
  type ApifyDeps,
  type ApifyDownloadPlan,
  type ApifyLang,
  type ApifyPlatform,
  type ApifySearchOutcome,
  type VisionModerationFrame,
  type VisionModerationSceneContext,
} from "@lyonix/providers";
import {
  canAccessProject,
  canWriteProjectResource,
  decideMediaSelection,
  rankMediaCandidates,
  candidateSubjectMatch,
  selectSocialCandidates,
  socialWindowOptionsFromEnv,
  personMatchLevelOf,
  personRejectionCounts,
  visionTargetOf,
  assessMediaCleanliness,
  PERSON_VERIFY_MIN_CONFIDENCE,
  type MediaCandidate,
  type RankedMediaCandidate,
  type SceneBrief,
} from "@lyonix/domain";
import type { ApifyCandidateResponse, ApifyImportResponse, ApifySearchResponse, ErrorCode, MediaPlanApifyQuality, MediaPlanReframeCheck } from "@lyonix/contracts";

/** VE2E-151: the person ranking of the chosen candidate (identity level, score, match level, hints) for the segment diagnostics. */
export const personQualityOf = (ranked: readonly RankedMediaCandidate[], candidateId: string): MediaPlanApifyQuality["person"] | undefined => {
  const person = ranked.find((entry) => entry.candidate.candidateId === candidateId)?.person;
  return person
    ? {
        identity: person.identity.level,
        score: Math.round(person.score * 1000) / 1000,
        match: personMatchLevelOf(person),
        flags: [...person.flags],
        tier: person.tier,
        identityConfidence: person.identityConfidence,
        verificationMethod: person.verificationMethod,
        framing: person.framingKind,
      }
    : undefined;
};
import { getSharedProviderLimiter, resolveConcurrencyConfig } from "./concurrency-config.js";
import { VisionBudget, moderatePoolWithBudget, resolveVisionModels, type ModelAvailability } from "./vision-budget.js";
import { CLEANLINESS_FRAME_COUNT, CLEANLINESS_FRAME_MAX_WIDTH, chosenCleanlinessDiagnostics, cleanlinessCheckEnabled, cleanlinessDiagnosticsOf } from "./media-cleanliness-diagnostics.js";
import { GrantsService } from "./grants.service.js";
import { mediaRoot } from "./handoff-workspace.js";
import { MediaService, sniffMediaMimeType } from "./media.service.js";
import { PrismaService } from "./prisma.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { VideoFramesService, visionVideoFramesEnabled } from "./video-frames.service.js";
import { ReframeService } from "./reframe.service.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";
import { fetchBinarySafely, type SafeBinaryFetchResult } from "./safe-binary-fetch.js";
import { writeQuarantineFile } from "./quarantine.js";
import { discardQuarantined, readQuarantineHead, SocialFetchService, socialFetchEnabled, type SocialFetchOutcome } from "./social-fetch.service.js";

type MediaAssetVersionSummaryLike = ApifyImportResponse["asset"];

export type ApifyOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

const IMPORT_REF_TTL_MS = 30 * 60 * 1000;
/** VE2E-51: TTL of the shared search cache (memory + file, so the API process (Studio) and the worker process (Auto) share it). Env `APIFY_CACHE_TTL_MS`. */
const DEFAULT_RESULT_CACHE_TTL_MS = 15 * 60 * 1000;
/** VE2E-132 (CR-MEDIA-SLA 3.2): search-only results (candidate metadata, no files) are reusable across jobs of the same topic for 24 h. */
const DEFAULT_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** `APIFY_CACHE_TTL_MS`, when set, applies to both kinds; otherwise search-only = 24 h and a result carrying download links = 15 min (links expire). */
const resultCacheTtlMs = (kind: "search" | "download" = "download") => {
  const raw = process.env.APIFY_CACHE_TTL_MS;
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  return kind === "search" ? DEFAULT_SEARCH_CACHE_TTL_MS : DEFAULT_RESULT_CACHE_TTL_MS;
};
/**
 * VE2E-132: download the chosen posts of a job in ONE Actor run (env `APIFY_BATCH_DOWNLOAD`). Default OFF until the owner-approved probe
 * confirms `clockworks/tiktok-scraper` takes several `postURLs` (and the field name, `APIFY_TIKTOK_POST_URL_FIELD`). OFF = one run per clip.
 */
export const apifyBatchDownloadEnabled = () => flagOn(process.env.APIFY_BATCH_DOWNLOAD, false);
/** Batch window (ms) after the first registered post before the single run starts (env `APIFY_BATCH_WINDOW_MS`, default 1500) and size threshold (`APIFY_BATCH_MAX`, default 8, <= adapter max). */
const apifyBatchWindowMs = () => { const v = Number(process.env.APIFY_BATCH_WINDOW_MS); return Number.isFinite(v) && v >= 0 ? v : 1500; };
const apifyBatchMax = () => { const v = Math.floor(Number(process.env.APIFY_BATCH_MAX)); return Number.isFinite(v) && v >= 1 ? Math.min(v, APIFY_MAX_BATCH_POSTS) : 8; };
/**
 * VE2E-131: Actor runs allowed at once per (project, platform) (env `APIFY_MAX_CONCURRENT_RUNS`, default 10). More searches WAIT in a FIFO
 * queue (up to `APIFY_QUEUE_WAIT_TIMEOUT_MS`, default 15 min) instead of failing with PROVIDER_RATE_LIMITED.
 */
export const apifyMaxConcurrentRuns = () => resolveConcurrencyConfig().apifyMaxConcurrentRuns;
const apifyQueueWaitTimeoutMs = () => resolveConcurrencyConfig().apifyQueueWaitTimeoutMs;
/** VE2E-51/131: phase-1 result count (20 = the adapter ceiling) and how many filtered candidates go on to vision moderation/ranking. */
export const APIFY_SEARCH_LIMIT = 20;
/** VE2E-131: phase 2 failing moves on to the next shortlisted candidate, at most this many candidates per segment (no single-phase re-search). */
export const APIFY_MAX_PHASE2_CANDIDATES = 2;
const PLAN_LIMIT_TTL_MS = 10 * 60_000;
const MAX_FILTERED_POOL = 8;
const flagOn = (value: string | undefined, fallback: boolean) => (value === undefined || value.trim() === "" ? fallback : !/^(0|false|off|no)$/i.test(value.trim()));
/**
 * `APIFY_TWO_PHASE` (default ON since the 01/10 read-only probe confirmed the `postURLs` input of
 * `clockworks/tiktok-scraper`: search ~12 s + one targeted download ~24 s, vs 2-4 min for the download search): `0` = classic single-phase.
 */
export const apifyTwoPhaseEnabled = () => flagOn(process.env.APIFY_TWO_PHASE, true);

/**
 * VE2E-51: state of ONE sourcing job (Auto run or Studio media plan): accumulated Apify spend and the identical
 * (platform, keyword) searches already made, so segments with the same keyword share one Actor run.
 */
type PostBatchEntry = { chosen: ApifyCandidateResult; waiters: Array<(r: { ok: true; result: ApifyCandidateResult } | { ok: false; code: string }) => void> };
type PostBatch = { entries: Map<string, PostBatchEntry>; timer: ReturnType<typeof setTimeout> | null };

export class ApifyJobContext {
  readonly usage: ApifyUsage & { searchesReused: number; libraryReuses: number } = { ...emptyApifyUsage(), searchesReused: 0, libraryReuses: 0 };
  readonly searches = new Map<string, Promise<ApifyOutcome<ApifySearchOutcome>>>();
  /** VE2E-57: per-job vision-moderation budget shared by every segment of the job. */
  readonly vision: VisionBudget;
  /** Clip ids whose download/import failed in this job: never picked again (a retry then moves on to the next ranked candidate). */
  readonly failedIds = new Set<string>();
  /** VE2E-132: posts waiting for the shared download run, per (account, lang). */
  readonly postBatches = new Map<string, PostBatch>();
  constructor(opts: { visionMaxCalls?: number } = {}) {
    this.vision = new VisionBudget(opts.visionMaxCalls ? { maxCalls: opts.visionMaxCalls } : {});
  }
  /**
   * VE2E-67: what a plan-time `overlay_unavoidable` verdict does. `swap` (Auto): the candidate fails and the existing fallback (next
   * platform, then Pexels) supplies another source. `flag` (Studio, default): the candidate is kept and the flag is shown to the user.
   */
  private policy: "swap" | "flag" = "flag";
  get overlayPolicy(): "swap" | "flag" {
    return this.policy;
  }
  /** `swap` = Auto (unattended): also tells the vision budget, so Auto drops the verified-signal gate when vision cannot run (VE2E-131). */
  set overlayPolicy(value: "swap" | "flag") {
    this.policy = value;
    this.vision.unattended = value === "swap";
  }
  addRun(usage: ApifyUsage) {
    addApifyUsage(this.usage, usage);
  }
  snapshot() {
    return { ...this.usage };
  }
}

const emptyQuality = (twoPhase: boolean): MediaPlanApifyQuality => ({ considered: 0, passed: 0, rejected: {}, rejectedExamples: [], twoPhase, phase2: "not_used", reusedLibraryAsset: false, searchReused: false });

export type AutoImportedAsset = Pick<MediaAssetVersionSummaryLike, "id" | "kind" | "durationMs">;
export type AutoImportOutcome =
  | { ok: true; data: { asset: AutoImportedAsset; externalId: string; ledgerId: string; provenance: MediaCandidate["provenance"]["apify"] | null; platform: ApifyPlatform; quality: MediaPlanApifyQuality } }
  | { ok: false; reason: string; quality?: MediaPlanApifyQuality };
/** Vision moderation spend guard per segment source (same bound as Pexels, VE2E-29). */
// VE2E-57: candidates per segment and calls per job now come from VisionBudget (VISION_MAX_CANDIDATES_PER_SEGMENT / VISION_MAX_CALLS_PER_JOB).
const MAX_VISION_PREVIEW_BYTES = 4 * 1024 * 1024;
const APIFY_PREVIEW_SUFFIXES = [...APIFY_HOST_ALLOWLIST.tiktok, ...APIFY_HOST_ALLOWLIST.pinterest, ...APIFY_HOST_ALLOWLIST.x, ...APIFY_HOST_ALLOWLIST.googlePreview];
const APIFY_LICENSE = "Apify-sourced social/web media - owner_accepted_risk (not rights-cleared); audio always stripped";

/** Everything the import step needs, sealed inside `importRef` (never trusted from the client). */
type ImportRefPayload = {
  v: 1;
  exp: number;
  projectId: string;
  providerAccountId: string;
  platform: ApifyPlatform;
  download: ApifyDownloadPlan;
  meta: { externalId: string; mediaType: "video" | "photo"; widthPx: number | null; heightPx: number | null; durationSeconds: number | null; title: string };
  provenance: Record<string, unknown>;
};

const ALL_ALLOWED_SUFFIXES = new Set<string>([...APIFY_HOST_ALLOWLIST.tiktok, ...APIFY_HOST_ALLOWLIST.pinterest, ...APIFY_HOST_ALLOWLIST.x, ...APIFY_HOST_ALLOWLIST.apifyApi]);

const providerFailure = (error: unknown): { code: ErrorCode; message: string; status: number; retryable: boolean } => {
  if (error instanceof ProviderError) {
    const status = error.code === "PROVIDER_RATE_LIMITED" ? 429 : error.code === "PROVIDER_AUTH_INVALID" ? 401 : 502;
    // The (already token-redacted) upstream message is passed through, per the 27/09 verify fix.
    return { code: error.code, message: error.message, status, retryable: error.retryable };
  }
  return { code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi Apify", status: 502, retryable: true };
};

const extFor = (mime: string) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" } as Record<string, string>)[mime] ?? "bin";

@Injectable()
export class ApifyService {
  private readonly cache = new Map<string, { at: number; outcome: ApifySearchOutcome }>();
  /** Identical searches already running (any job/Studio call) share one promise instead of paying twice. */
  private readonly pending = new Map<string, Promise<ApifyOutcome<ApifySearchOutcome>>>();
  /** Running Actor searches per `project:platform` (bounded by {@link apifyMaxConcurrentRuns}); extra searches wait in `waiting` (FIFO). */
  private readonly running = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  private readonly planLimitCheckedAt = new Map<string, number>();
  /** Test seam: stubbed Apify API. Production leaves this undefined (global fetch). */
  apifyDeps: ApifyDeps | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(MediaService) private readonly media: MediaService,
    /** Only needed for the Auto vision-moderation pass (VE2E-46); omitted in unit tests that do not exercise it. */
    @Optional() @Inject(ProviderAccountsService) private readonly providerAccounts?: ProviderAccountsService,
    /** VE2E-30: frames of imported videos for vision moderation (media worker). Omitted = frame check is always `unchecked`. */
    @Optional() @Inject(VideoFramesService) private readonly videoFrames?: VideoFramesService,
    /** VE2E-67: plan-time crop/overlay check. Omitted = no check (identical to the previous behaviour). */
    @Optional() @Inject(ReframeService) private readonly reframe?: ReframeService,
    /** VE2E-146: yt-dlp download of the chosen TikTok post (MEDIA_FETCH_YTDLP=1); Apify phase 2 stays the fallback. */
    @Optional() @Inject(SocialFetchService) private readonly socialFetch?: SocialFetchService,
  ) {}

  private async access(projectId: string, userId: string, role: "admin" | "staff", write: boolean) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return false;
    const grants = await this.grants.forUser(userId, role);
    return write ? canWriteProjectResource(role, grants, projectId) : canAccessProject(role, grants, projectId);
  }

  /** A non-deleted, verified `apify`/`visual` account (test-only fake accounts allowed under NODE_ENV=test, like Pexels). */
  async usableAccount(providerAccountId: string): Promise<ApifyOutcome<{ id: string; encryptedSecret: string }>> {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, deletedAt: null } });
    if (!account) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản Apify không tồn tại hoặc đã bị xóa", status: 503 };
    if (account.role !== "visual" || account.provider !== "apify") return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Tài khoản không phải Apify (visual)", status: 503 };
    if (account.enabled === false) return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Nguồn Apify đang tắt trong cấu hình provider", status: 403 };
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản Apify chưa verify", status: 503 };
    return { ok: true, data: { id: account.id, encryptedSecret: account.encryptedSecret } };
  }

  /** Server-internal search (also used by MediaPlanService, VE2E-46): raw candidates incl. download plans. Access is checked by the caller-facing wrappers. */
  async searchRaw(
    projectId: string,
    account: { id: string; encryptedSecret: string },
    input: { platform: ApifyPlatform; keyword: string; lang: ApifyLang; limit?: number; download?: boolean; runTimeoutSecs?: number },
    job?: ApifyJobContext,
  ): Promise<ApifyOutcome<ApifySearchOutcome>> {
    return (await this.searchShared(projectId, account, input, job)).outcome;
  }

  private cacheDir() {
    return join(mediaRoot(), "_apify_cache");
  }

  private async readFileCache(key: string, ttl: number): Promise<ApifySearchOutcome | null> {
    try {
      const path = join(this.cacheDir(), `${key}.json`);
      const info = await stat(path);
      if (Date.now() - info.mtimeMs >= ttl) return null;
      const parsed = JSON.parse(await readFile(path, "utf8")) as ApifySearchOutcome;
      return parsed && Array.isArray(parsed.results) && parsed.actor && typeof parsed.runId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeFileCache(key: string, outcome: ApifySearchOutcome, ttl: number): Promise<void> {
    try {
      const dir = this.cacheDir();
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${key}.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify(outcome));
      await rename(tmp, join(dir, `${key}.json`));
      // Best-effort prune of expired entries (working files are short-lived, never kept for days).
      for (const name of await readdir(dir)) {
        const info = await stat(join(dir, name)).catch(() => null);
        if (info && Date.now() - info.mtimeMs >= Math.max(ttl, resultCacheTtlMs("search"), 60_000)) await unlink(join(dir, name)).catch(() => undefined);
      }
    } catch {
      // The cache is an optimisation only.
    }
  }

  /** Takes a per-(project, platform) run slot, waiting FIFO; resolves false when the (large, env) wait timeout passes. */
  private async acquireRunSlot(flightKey: string): Promise<boolean> {
    if ((this.running.get(flightKey) ?? 0) < apifyMaxConcurrentRuns() && (this.waiting.get(flightKey)?.length ?? 0) === 0) {
      this.running.set(flightKey, (this.running.get(flightKey) ?? 0) + 1);
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const queue = this.waiting.get(flightKey) ?? [];
      this.waiting.set(flightKey, queue);
      const grant = () => { clearTimeout(timer); resolve(true); }; // the releasing run hands its slot over (running count unchanged)
      const timer = setTimeout(() => {
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
        resolve(false);
      }, apifyQueueWaitTimeoutMs());
      queue.push(grant);
    });
  }

  private releaseRunSlot(flightKey: string): void {
    const queue = this.waiting.get(flightKey);
    const next = queue && queue.length > 0 && (this.running.get(flightKey) ?? 0) <= apifyMaxConcurrentRuns() ? queue.shift() : undefined;
    if (next) {
      next();
      return;
    }
    this.running.set(flightKey, Math.max(0, (this.running.get(flightKey) ?? 1) - 1));
  }

  /**
   * VE2E-131: the shared "apify" limiter wraps ONE Actor call (a search or a post download) only - never a whole segment flow, so vision,
   * file download and reframe run outside the slot. Waiting for a slot is a queue, not an error (timeout: APIFY_QUEUE_WAIT_TIMEOUT_MS).
   */
  private actorCall<T>(fn: () => Promise<T>): Promise<T> {
    return getSharedProviderLimiter().run("apify", fn);
  }

  /**
   * VE2E-131: lowers the live "apify" cap to the plan's real `maxConcurrentActorJobs` (GET /v2/users/me/limits, read-only, best effort,
   * re-checked every 10 min per account). The env value stays the ceiling. Skipped under NODE_ENV=test and `APIFY_PLAN_LIMIT_PROBE=0`.
   */
  async syncPlanConcurrency(account: { id: string; encryptedSecret: string }): Promise<number | null> {
    const last = this.planLimitCheckedAt.get(account.id) ?? 0;
    if (Date.now() - last < PLAN_LIMIT_TTL_MS) return null;
    this.planLimitCheckedAt.set(account.id, Date.now());
    const plan = await fetchApifyConcurrencyLimit(decryptSecret(account.encryptedSecret), this.apifyDeps).catch(() => null);
    if (plan === null) return null;
    const ceiling = resolveConcurrencyConfig().providerLimits.apify;
    const effective = Math.max(1, Math.min(ceiling, plan));
    getSharedProviderLimiter().setLimit("apify", effective);
    return effective;
  }

  /**
   * VE2E-51 shared search: TTL cache (memory + file, shared by Studio and Auto), identical (platform, keyword) searches of one
   * job reused, identical in-flight searches share one run, up to {@link apifyMaxConcurrentRuns} distinct runs (the rest queue) per
   * (project, platform). A search-only request is also answered from a cached full-download result (superset).
   */
  private async searchShared(
    projectId: string,
    account: { id: string; encryptedSecret: string },
    input: { platform: ApifyPlatform; keyword: string; lang: ApifyLang; limit?: number; download?: boolean; runTimeoutSecs?: number },
    job?: ApifyJobContext,
  ): Promise<{ outcome: ApifyOutcome<ApifySearchOutcome>; reused: boolean }> {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 10), 1), 20);
    const keyword = input.keyword.trim().replace(/\s+/g, " ");
    const download = input.download !== false;
    const keyFor = (dl: boolean) => createHash("sha256").update([account.id, input.platform, input.lang, limit, keyword.normalize("NFKC").toLowerCase(), dl ? "download" : "search"].join("\u0000")).digest("hex");
    const key = keyFor(download);
    const altKey = download ? null : keyFor(true);
    const ttlFor = (dl: boolean) => resultCacheTtlMs(dl ? "download" : "search");
    const ttl = ttlFor(download);

    const memo = job?.searches.get(key);
    if (memo) {
      job!.usage.searchesReused += 1;
      return { outcome: await memo, reused: true };
    }
    const work = (async (): Promise<{ outcome: ApifyOutcome<ApifySearchOutcome>; reused: boolean }> => {
      {
        const now = Date.now();
        for (const candidate of altKey ? [key, altKey] : [key]) {
          const hit = this.cache.get(candidate);
          const candidateTtl = ttlFor(candidate === altKey ? true : download);
          if (hit && candidateTtl > 0 && now - hit.at < candidateTtl) return { outcome: { ok: true, data: hit.outcome }, reused: true };
        }
        for (const candidate of altKey ? [key, altKey] : [key]) {
          const candidateTtl = ttlFor(candidate === altKey ? true : download);
          if (candidateTtl <= 0) continue;
          const hit = await this.readFileCache(candidate, candidateTtl);
          if (hit) {
            this.cache.set(candidate, { at: now, outcome: hit });
            return { outcome: { ok: true, data: hit }, reused: true };
          }
        }
      }
      const inFlight = this.pending.get(key);
      if (inFlight) return { outcome: await inFlight, reused: true };
      const flightKey = `${projectId}:${input.platform}`;
      const usage = emptyApifyUsage();
      // Registered in `pending` synchronously (no await since the check above), so identical searches share this run even while it queues.
      const run = (async (): Promise<ApifyOutcome<ApifySearchOutcome>> => {
        if (!(await this.acquireRunSlot(flightKey))) {
          return { ok: false, code: "PROVIDER_RATE_LIMITED", message: "Hàng đợi Apify quá lâu, thử lại sau.", status: 429, retryable: true };
        }
        try {
          if (process.env.NODE_ENV !== "test" && process.env.APIFY_PLAN_LIMIT_PROBE !== "0") await this.syncPlanConcurrency(account);
          const outcome = await this.actorCall(() => searchApify(
            decryptSecret(account.encryptedSecret),
            { platform: input.platform, keyword, lang: input.lang, limit, providerAccountId: account.id, download, usageSink: usage, ...(input.runTimeoutSecs ? { runTimeoutSecs: input.runTimeoutSecs } : {}) },
            this.apifyDeps,
          ));
          if (ttl > 0) {
            const now = Date.now();
            this.cache.set(key, { at: now, outcome });
            if (this.cache.size > 200) for (const [k, value] of this.cache) if (now - value.at >= Math.max(ttl, resultCacheTtlMs("search"))) this.cache.delete(k);
            await this.writeFileCache(key, outcome, ttl);
          }
          return { ok: true, data: outcome };
        } catch (error) {
          return { ok: false, ...providerFailure(error) };
        } finally {
          job?.addRun(usage);
          this.releaseRunSlot(flightKey);
        }
      })();
      this.pending.set(key, run);
      void run.then(() => { if (this.pending.get(key) === run) this.pending.delete(key); });
      return { outcome: await run, reused: false };
    })();
    job?.searches.set(key, work.then((result) => result.outcome));
    return work;
  }

  private seal(projectId: string, providerAccountId: string, platform: ApifyPlatform, result: ApifyCandidateResult): string | null {
    if (!result.download) return null;
    const { candidate } = result;
    const payload: ImportRefPayload = {
      v: 1,
      exp: Date.now() + IMPORT_REF_TTL_MS,
      projectId,
      providerAccountId,
      platform,
      download: result.download,
      meta: { externalId: candidate.externalId, mediaType: candidate.mediaType, widthPx: candidate.widthPx ?? null, heightPx: candidate.heightPx ?? null, durationSeconds: candidate.durationSeconds ?? null, title: candidate.descriptorText ?? "" },
      provenance: { platform, rightsStatus: "owner_accepted_risk", apify: candidate.provenance.apify ?? null, attribution: candidate.attribution, query: candidate.provenance.query },
    };
    return encryptSecret(JSON.stringify(payload));
  }

  private unseal(importRef: string): ImportRefPayload | null {
    try {
      const payload = JSON.parse(decryptSecret(importRef)) as ImportRefPayload;
      if (payload?.v !== 1 || typeof payload.exp !== "number" || payload.exp < Date.now() || !isApifyPlatform(payload.platform) || !payload.download?.url) return null;
      return payload;
    } catch {
      return null;
    }
  }

  async search(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; platform: string; query: string; lang?: string; limit?: number },
  ): Promise<ApifyOutcome<ApifySearchResponse>> {
    if (!(await this.access(projectId, userId, role, false))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    if (!isApifyPlatform(input.platform)) return { ok: false, code: "VALIDATION_FAILED", message: "Nền tảng Apify không được hỗ trợ" };
    const query = input.query.trim();
    if (!query || query.length > 200) return { ok: false, code: "VALIDATION_FAILED", message: "Từ khóa tìm kiếm không hợp lệ" };
    const lang: ApifyLang = input.lang === "en" ? "en" : "ja";
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    const raw = await this.searchRaw(projectId, account.data, { platform: input.platform, keyword: query, lang, ...(input.limit !== undefined ? { limit: input.limit } : {}) });
    if (!raw.ok) return raw;
    const outcome = raw.data;
    const candidates: ApifyCandidateResponse[] = outcome.results.map((result) => {
      const { candidate } = result;
      const importRef = this.seal(projectId, account.data.id, input.platform as ApifyPlatform, result);
      return {
        candidateId: candidate.candidateId,
        platform: input.platform as ApifyPlatform,
        mediaType: candidate.mediaType,
        importable: importRef !== null,
        previewOnlyReason: importRef === null ? (candidate.eligibility.reason ?? "discovery_only_no_import_capability") : null,
        previewUrl: candidate.previewUrl,
        durationSeconds: candidate.durationSeconds ?? null,
        widthPx: candidate.widthPx ?? null,
        heightPx: candidate.heightPx ?? null,
        title: candidate.descriptorText ?? "",
        author: candidate.attribution?.name ?? null,
        sourcePageUrl: candidate.attribution?.sourcePageUrl ?? null,
        rightsStatus: "owner_accepted_risk",
        importRef,
      };
    });
    return { ok: true, data: { platform: input.platform as ApifyPlatform, query, lang, actor: outcome.actor, fetchedAt: new Date().toISOString(), primaryError: outcome.primaryError, candidates } };
  }

  async import(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; importRef: string; folderId?: string | null; reusable?: boolean; sceneId?: string | null },
  ): Promise<ApifyOutcome<ApifyImportResponse>> {
    if (!(await this.access(projectId, userId, role, true))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    const payload = this.unseal(input.importRef);
    if (!payload || payload.projectId !== projectId || payload.providerAccountId !== account.data.id) {
      return { ok: false, code: "VALIDATION_FAILED", message: "importRef không hợp lệ hoặc đã hết hạn, hãy tìm lại.", status: 400 };
    }
    return this.importPlan(projectId, userId, role, account.data, { plan: payload.download, platform: payload.platform, meta: payload.meta, provenance: payload.provenance }, input);
  }

  /** Server-internal import of a search result (MediaPlanService, VE2E-46) - same download/registration path as `import`. */
  async importResult(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    account: { id: string; encryptedSecret: string },
    platform: ApifyPlatform,
    result: ApifyCandidateResult,
    options: { sceneId?: string | null; folderId?: string | null } = {},
  ): Promise<ApifyOutcome<ApifyImportResponse>> {
    if (!result.download) return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Candidate chỉ để xem trước, không import được", status: 400 };
    const { candidate } = result;
    return this.importPlan(
      projectId, userId, role, account,
      {
        plan: result.download,
        platform,
        meta: { externalId: candidate.externalId, mediaType: candidate.mediaType, widthPx: candidate.widthPx ?? null, heightPx: candidate.heightPx ?? null, durationSeconds: candidate.durationSeconds ?? null, title: candidate.descriptorText ?? "" },
        provenance: { platform, rightsStatus: "owner_accepted_risk", apify: candidate.provenance.apify ?? null, attribution: candidate.attribution, query: candidate.provenance.query },
      },
      { ...options, reusable: true },
    );
  }


  /**
   * VE2E-46: the project's verified Apify account visible to this user (org-scoped, or the user's own personal one;
   * admins see all), or `null`. Same visibility rules as `GET /provider-accounts`.
   */
  /** Every usable Apify account of the user, oldest first (a quota-exhausted account is skipped for the next one). */
  async findAccountsForUser(userId: string, role: "admin" | "staff"): Promise<Array<{ id: string; encryptedSecret: string }>> {
    const rows = await this.prisma.providerAccount.findMany({
      where: {
        provider: "apify",
        role: "visual",
        deletedAt: null,
        enabled: true,
        ...(process.env.NODE_ENV === "test" ? {} : { status: "verified", isFake: false }),
        ...(role === "admin" ? {} : { OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: userId }] }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const out: Array<{ id: string; encryptedSecret: string }> = [];
    for (const row of rows) {
      const usable = await this.usableAccount(row.id);
      if (usable.ok) out.push(usable.data);
    }
    return out;
  }

  async findAccountForUser(userId: string, role: "admin" | "staff"): Promise<{ id: string; encryptedSecret: string } | null> {
    const row = await this.prisma.providerAccount.findFirst({
      where: {
        provider: "apify",
        role: "visual",
        deletedAt: null,
        enabled: true,
        ...(process.env.NODE_ENV === "test" ? {} : { status: "verified", isFake: false }),
        ...(role === "admin" ? {} : { OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: userId }] }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!row) return null;
    const usable = await this.usableAccount(row.id);
    return usable.ok ? usable.data : null;
  }

  /**
   * VE2E-46: one vision-moderation pass per segment source over the top-ranked candidates' preview frames
   * (cover image; never the video itself). Candidates whose preview cannot be fetched, or when no vision-capable
   * content account exists, keep their metadata-only score - moderation only ever strengthens evidence / rejects.
   */
  private async moderatePool(pool: MediaCandidate[], brief: SceneBrief, userId: string, role: "admin" | "staff", usedExternalIds: ReadonlySet<string>, budget: VisionBudget, scopeKey: string, fetchFrames?: (candidate: MediaCandidate) => Promise<VisionModerationFrame[]>): Promise<MediaCandidate[]> {
    if (!this.providerAccounts) return pool;
    const accounts = await this.providerAccounts.contentGenerationCandidates(userId, role);
    const account = accounts.find((a) => a.role === "content" && isLiveContentKind(a.provider) && (a.isFake ? process.env.NODE_ENV === "test" : a.status === "verified"));
    if (!account) return pool;
    // VE2E-151: a person subject also gets the shot description (people / close-up / text / logo / news card) in the same call.
    // The SAME call also checks the identity against the target person (match / different person / uncertain / nobody).
    // VE2E-152: the same call also rates how clean the media is (overlaid text, logo, watermark, subtitles, edit layout).
    const sceneContext: VisionModerationSceneContext = { beat: brief.beat, entities: brief.entities, action: brief.action, setting: brief.setting, mood: brief.mood, exclusions: brief.exclusions, ...(brief.person ? { personShot: true, targetPerson: visionTargetOf(brief.person) } : {}), ...(cleanlinessCheckEnabled() ? { cleanliness: true } : {}) };
    const models = resolveVisionModels(account.model, account.availableModels, account.visionModel);
    return moderatePoolWithBudget({
      pool,
      brief,
      usedExternalIds,
      scopeKey,
      budget,
      account: { id: account.id, provider: account.provider, apiKey: decryptSecret(account.encryptedSecret), model: models[0] ?? account.model, models },
      sceneContext,
      availability: this.providerAccounts as unknown as ModelAvailability,
      ...(fetchFrames ? { fetchFrames } : {}),
      fetchFrame: async (candidate) => {
        const frame = await fetchBinarySafely(candidate.previewUrl, { maxBytes: MAX_VISION_PREVIEW_BYTES, allowedHostSuffixes: APIFY_PREVIEW_SUFFIXES, allowedMimePrefixes: ["image/"] });
        if (!frame.ok) return null;
        const visionFrame: VisionModerationFrame = { mimeType: frame.mimeType || "image/jpeg", base64: frame.buffer.toString("base64") };
        return visionFrame;
      },
    });
  }

  /**
   * VE2E-30: vision verdict over frames sampled from the IMPORTED video (media worker `frame.extract`), reusing the same
   * budgeted pipeline as the cover-frame pass. Opt-in (`VISION_VIDEO_FRAMES=1`). Only an explicit `rejected` decision blocks the
   * clip; everything else (flag off, no vision account/budget/frames, worker down) is `unchecked` and never fails sourcing.
   */
  private async verifyVideoFrames(asset: AutoImportedAsset, candidate: MediaCandidate, brief: SceneBrief, userId: string, role: "admin" | "staff", usedExternalIds: ReadonlySet<string>, budget: VisionBudget, scopeKey: string, quality?: MediaPlanApifyQuality): Promise<"accepted" | "rejected" | "unchecked"> {
    if (!visionVideoFramesEnabled() || !this.videoFrames || asset.kind !== "video") return "unchecked";
    try {
      // VE2E-152: 5 low-res frames (start / 25% / 50% / 75% / end) - enough to tell a captioned / watermarked edit from raw footage.
      const moderated = await this.moderatePool([candidate], brief, userId, role, usedExternalIds, budget, `${scopeKey}:frames`, async () => {
        const outcome = await this.videoFrames!.framesForAsset(asset.id, { frameCount: CLEANLINESS_FRAME_COUNT, maxWidth: CLEANLINESS_FRAME_MAX_WIDTH });
        return outcome.ok ? outcome.frames : [];
      });
      const frameCleanliness = moderated[0]?.visionFindings?.cleanliness;
      if (frameCleanliness) {
        const verdict = assessMediaCleanliness({ vision: frameCleanliness, text: candidate.descriptorText ?? null, platformSignals: candidate.editSignals ?? [] });
        if (quality) quality.frameCleanliness = cleanlinessDiagnosticsOf(verdict, false);
        // >= 2 frames with heavy text / watermark, continuous subtitles, social UI, a finished edit: drop it (the next candidate is tried).
        if (verdict.tier === "reject") return "rejected";
      }
      const decision = moderated[0]?.moderationDecision ?? null;
      // VE2E-151: frames of the downloaded clip that show a different person than the target reject it like an unsafe clip.
      const identity = moderated[0]?.visionFindings?.identity;
      if (brief.person && identity && quality) quality.frameIdentity = { match: identity.match, confidence: identity.confidence };
      if (brief.person && identity?.match === "different_person" && identity.confidence >= PERSON_VERIFY_MIN_CONFIDENCE) return "rejected";
      return decision === "rejected" ? "rejected" : decision === "accepted" ? "accepted" : "unchecked";
    } catch {
      return "unchecked";
    }
  }

  /**
   * VE2E-67: plan-time screen of an Apify candidate with the worker's `reframe.analyze` (subject + logo/caption overlay). The analysed
   * window is the one the segment will use (start guard, segment duration). Records `quality.reframe` (shown to Studio users) and returns
   * `reject` ONLY for an unavoidable overlay under the Auto `swap` policy; an analysis that cannot run never blocks sourcing here (it is
   * flagged `analysis_unavailable` + logged by ReframeService; the render step applies REFRAME_LEGACY_FALLBACK).
   */
  private async reframeCheck(asset: AutoImportedAsset, input: { segmentDurationSeconds?: number }, job: ApifyJobContext, quality: MediaPlanApifyQuality): Promise<"keep" | "reject"> {
    if (!this.reframe || !this.reframe.enabledFor("apify")) return "keep";
    try {
      const row = await this.prisma.mediaAssetVersion.findFirst({ where: { id: asset.id, deletedAt: null } });
      if (!row || (row.kind !== "video" && row.kind !== "image")) return "keep";
      let window: { startMs: number; durationMs: number } | null = null;
      if (row.kind === "video" && row.durationMs && row.durationMs > 0) {
        const guard = socialWindowOptionsFromEnv();
        const startMs = Math.min(guard.startGuardMs, Math.max(0, row.durationMs - 1000));
        const wanted = input.segmentDurationSeconds && input.segmentDurationSeconds > 0 ? Math.round(input.segmentDurationSeconds * 1000) : row.durationMs;
        window = { startMs, durationMs: Math.max(100, Math.min(wanted, 60_000, row.durationMs - startMs)) };
      }
      const decision = await this.reframe.plan({ id: row.id, kind: row.kind as "video" | "image", origin: row.origin, relativePath: row.relativePath, checksumSha256: row.checksumSha256 ?? null }, window);
      if (decision.status === "skipped") return "keep";
      if (decision.status === "legacy_fallback" || decision.status === "failed") {
        quality.reframe = { status: "analysis_unavailable", overlayUnavoidable: false, residualOverlayPct: 0, subjectCoveragePct: 100, zoomPermille: null, confidenceLevel: null, swapped: false, reason: decision.code };
        return "keep";
      }
      const swap = decision.overlayUnavoidable && job.overlayPolicy === "swap" && this.reframe.policy().autoSwapOnOverlay;
      const check: MediaPlanReframeCheck = {
        status: decision.overlayUnavoidable ? "overlay_unavoidable" : "ok",
        overlayUnavoidable: decision.overlayUnavoidable,
        residualOverlayPct: decision.residualOverlayPct,
        subjectCoveragePct: decision.subjectCoveragePct,
        zoomPermille: decision.zoomPermille,
        confidenceLevel: decision.confidenceLevel,
        swapped: swap,
        ...(decision.warnings.length > 0 ? { warnings: decision.warnings } : {}),
      };
      quality.reframe = check;
      return swap ? "reject" : "keep";
    } catch {
      return "keep"; // best-effort screen: never fail sourcing because the check itself broke
    }
  }

  /** VE2E-51: an asset of this project already imported from the same platform video (no second download). */
  private async findLibraryAsset(projectId: string, platform: ApifyPlatform, externalId: string): Promise<AutoImportedAsset | null> {
    const safeId = externalId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!safeId) return null;
    try {
      const row = await this.prisma.mediaAssetVersion.findFirst({
        where: { projectId, deletedAt: null, parentMediaAssetVersionId: null, kind: "video", originalFileName: { startsWith: `apify-${platform}-${safeId}.` } },
        orderBy: { createdAt: "desc" },
      });
      return row ? { id: row.id, kind: row.kind as AutoImportedAsset["kind"], durationMs: row.durationMs } : null;
    } catch {
      return null;
    }
  }

  /**
   * VE2E-132: segments sourced in parallel register their chosen post here; the first registration opens a short window
   * (`APIFY_BATCH_WINDOW_MS`), reaching `APIFY_BATCH_MAX` posts flushes at once, then ONE Actor run downloads them all and every segment
   * receives its own result (matched by video id). A clip missing from the result fails only its own segment (-> next candidate).
   */
  private joinPostBatch(account: { id: string; encryptedSecret: string }, chosen: ApifyCandidateResult, job: ApifyJobContext, lang: ApifyLang): Promise<{ ok: true; result: ApifyCandidateResult } | { ok: false; code: string }> {
    const batchKey = `${account.id}:${lang}`;
    let batch = job.postBatches.get(batchKey);
    if (!batch) {
      batch = { entries: new Map(), timer: null };
      job.postBatches.set(batchKey, batch);
    }
    const open = batch;
    return new Promise((resolve) => {
      const id = chosen.candidate.externalId;
      const entry = open.entries.get(id) ?? { chosen, waiters: [] };
      entry.waiters.push(resolve);
      open.entries.set(id, entry);
      const flush = () => {
        if (open.timer) clearTimeout(open.timer);
        open.timer = null;
        if (job.postBatches.get(batchKey) === open) job.postBatches.delete(batchKey);
        void this.runPostBatch(account, open, job, lang);
      };
      if (open.entries.size >= apifyBatchMax()) flush();
      else if (!open.timer) open.timer = setTimeout(flush, apifyBatchWindowMs());
    });
  }

  private async runPostBatch(account: { id: string; encryptedSecret: string }, batch: PostBatch, job: ApifyJobContext, lang: ApifyLang): Promise<void> {
    const entries = [...batch.entries.entries()];
    const usage = emptyApifyUsage();
    const settle = (id: string, value: { ok: true; result: ApifyCandidateResult } | { ok: false; code: string }) => {
      for (const waiter of batch.entries.get(id)!.waiters) waiter(value);
    };
    try {
      const outcome = await this.actorCall(() => fetchApifyTikTokPosts(
        decryptSecret(account.encryptedSecret),
        {
          posts: entries.map(([id, e]) => ({ postUrl: e.chosen.deferredPostUrl ?? "", expectedVideoId: id })),
          lang,
          providerAccountId: account.id,
          runTimeoutSecs: APIFY_DOWNLOAD_RUN_TIMEOUT_SECS,
          usageSink: usage,
          ...(process.env.APIFY_TIKTOK_POST_URL_FIELD ? { postUrlField: process.env.APIFY_TIKTOK_POST_URL_FIELD } : {}),
        },
        this.apifyDeps,
      ));
      for (const [id] of entries) {
        const found = outcome.byVideoId.get(id);
        settle(id, found?.ok ? { ok: true, result: found.result } : { ok: false, code: found && !found.ok ? found.code : "PROVIDER_SCHEMA_INVALID" });
      }
    } catch (error) {
      const code = error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE";
      for (const [id] of entries) settle(id, { ok: false, code });
    } finally {
      job.addRun(usage); // the whole batch is ONE run: counted once
    }
  }

  /** Phase 2: run the primary TikTok Actor for ONE chosen post with download on; the result is import-ready. Usage goes to the job. */
  private async fetchChosenPost(
    account: { id: string; encryptedSecret: string },
    chosen: ApifyCandidateResult,
    job: ApifyJobContext,
    lang: ApifyLang = "ja",
  ): Promise<{ ok: true; result: ApifyCandidateResult } | { ok: false; code: string }> {
    if (apifyBatchDownloadEnabled() && chosen.deferredPostUrl) return this.joinPostBatch(account, chosen, job, lang);
    const usage = emptyApifyUsage();
    try {
      const outcome = await this.actorCall(() => fetchApifyTikTokPost(
        decryptSecret(account.encryptedSecret),
        {
          postUrl: chosen.deferredPostUrl ?? "",
          expectedVideoId: chosen.candidate.externalId,
          lang,
          providerAccountId: account.id,
          runTimeoutSecs: APIFY_DOWNLOAD_RUN_TIMEOUT_SECS,
          usageSink: usage,
          ...(process.env.APIFY_TIKTOK_POST_URL_FIELD ? { postUrlField: process.env.APIFY_TIKTOK_POST_URL_FIELD } : {}),
        },
        this.apifyDeps,
      ));
      const result = outcome.results[0];
      return result ? { ok: true, result } : { ok: false, code: "PROVIDER_SCHEMA_INVALID" };
    } catch (error) {
      return { ok: false, code: error instanceof ProviderError ? error.code : "PROVIDER_UNAVAILABLE" };
    } finally {
      job.addRun(usage);
    }
  }

  /**
   * VE2E-46/51 Auto/Studio-auto-fill source for ONE segment. For TikTok (default two-phase flow):
   *  1. one search WITHOUT downloading (10 results; identical (platform, keyword) searches of a job and the shared TTL cache
   *     are reused), 2. dataset-evidence filter + ranking (`selectSocialCandidates`: ja language, JP location, no ads/sponsored,
   *     no template/greenscreen/CapCut, vertical, duration >= the segment, keyword overlap; reject reasons -> `quality`),
   *     3. the shared vision pass + `decideMediaSelection` over the survivors, 4. the winner is taken from the project library
   *     when its video id was already imported, else 5. the Actor runs for ONLY the chosen post URL with download on (falling
   *     back to the classic download search when `APIFY_TWO_PHASE_FALLBACK` is on), then the KV-store import.
   * Other platforms, and TikTok with `APIFY_TWO_PHASE=0`, keep the single-phase flow (download during the search).
   * The chosen video id is reserved in `usedExternalIds` (the caller's live set) synchronously at decision time, so segments
   * sourced concurrently can never pick the same clip. Google video and preview-only candidates never enter the pool.
   * Never throws; any failure is a `reason` so the caller can fall back to Pexels.
   */
  async autoImportForSegment(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    account: { id: string; encryptedSecret: string },
    input: {
      platform: ApifyPlatform;
      keyword: string;
      brief: SceneBrief;
      sceneId: string;
      /** Plain platform video ids already used (live set: the chosen id is added here before any await). */
      usedExternalIds: Set<string>;
      /** Script language: `ja` scripts only accept Japanese-language, JP-located clips (else Pexels). Omitted = no language rule. */
      scriptLanguage?: string;
      /** Template-aware sourcing: only candidates of this kind (`image` = photo, `video` = video) are eligible. Omitted = any importable candidate. */
      mediaType?: "video" | "image";
      /** The segment's duration: candidates shorter than this are rejected (they would loop). */
      segmentDurationSeconds?: number;
      job?: ApifyJobContext;
      /** No other source can replace this one (Pexels off): accept the best metadata-ranked candidate when vision moderation could not run, instead of abstaining. */
      allowUnverified?: boolean;
      /** Last resort: an `overlay_unavoidable` clip is kept (and flagged) rather than rejected. */
      keepOverlayFlagged?: boolean;
      /** Best-effort fill: skip the strict social filter and the relevance threshold; vision rejections still apply. */
      lenient?: boolean;
      /** VE2E-131 search tier/language (default `ja`, as before). `en` = English keyword + loosened social filter (en/un captions, outside Japan, landscape). */
      lang?: ApifyLang;
      /** VE2E-131: proper names/aliases of the video subject; a caption/hashtag hit raises the candidate's filter score. */
      subjectAliases?: readonly string[];
    },
  ): Promise<AutoImportOutcome> {
    if (input.platform === "google_video") return { ok: false, reason: "platform_not_importable" };
    const job = input.job ?? new ApifyJobContext();
    const lang: ApifyLang = input.lang === "en" ? "en" : "ja";
    const twoPhase = input.platform === "tiktok" && apifyTwoPhaseEnabled();
    const quality = emptyQuality(twoPhase);
    const fail = (reason: string): AutoImportOutcome => ({ ok: false, reason, quality });
    const searched = await this.searchShared(projectId, account, { platform: input.platform, keyword: input.keyword, lang, limit: APIFY_SEARCH_LIMIT, download: !twoPhase }, job);
    quality.searchReused = searched.reused;
    if (!searched.outcome.ok) return fail(`apify_error:${searched.outcome.code}`);
    const filterContext = { scriptLanguage: input.scriptLanguage ?? "", keyword: input.keyword, minDurationSeconds: input.segmentDurationSeconds ?? 0, usedVideoIds: input.usedExternalIds, tier: lang, ...(input.subjectAliases?.length ? { subjectAliases: input.subjectAliases } : {}), ...(input.brief.person ? { person: input.brief.person } : {}) };
    /** Importable (or, in phase 1, downloadable-later) candidates that pass the dataset-evidence filter, best first. */
    const shortlist = (results: ApifyCandidateResult[]): ApifyCandidateResult[] => {
      const wantedType = input.mediaType === undefined ? null : input.mediaType === "image" ? "photo" : "video";
      const eligible = results.filter((r) => !job.failedIds.has(r.candidate.externalId) && (r.download !== null || r.deferredPostUrl) && r.candidate.accessMethod === "api_download" && r.candidate.eligibility.autoEligible && (wantedType === null || r.candidate.mediaType === wantedType));
      if (input.platform !== "tiktok") return eligible;
      if (input.lenient) {
        // Best effort: keep every importable candidate that was not already used (language/orientation/length rules are only preferences now).
        quality.considered = eligible.length;
        return eligible.filter((r) => !input.usedExternalIds.has(r.candidate.externalId)).slice(0, MAX_FILTERED_POOL);
      }
      const selection = selectSocialCandidates(
        eligible.filter((r) => r.social).map((r) => ({ ref: r, signals: r.social! })),
        filterContext,
      );
      quality.considered = eligible.length;
      quality.passed = selection.passed.length;
      quality.rejected = selection.rejectCounts;
      quality.rejectedExamples = selection.rejected.slice(0, 5).map((r) => ({ videoId: r.videoId, reasons: [...r.reasons] }));
      return selection.passed.slice(0, MAX_FILTERED_POOL).map((p) => p.ref);
    };
    const usable = shortlist(searched.outcome.data.results);
    if (usable.length === 0) return fail("apify_no_usable_candidate");
    const byCandidateId = new Map(usable.map((r) => [r.candidate.candidateId, r] as const));
    let pool = usable.map((r) => r.candidate);
    try {
      pool = await this.moderatePool(pool, input.brief, userId, role, input.usedExternalIds, job.vision, input.sceneId);
    } catch {
      // Moderation is best-effort evidence; a failing vision call must not abort sourcing (candidates stay metadata-only).
    }
    // VE2E-131: Auto (unattended job) no longer demands a verified semantic signal when vision produced no verdict at all
    // (quota / timeout / no vision account): the metadata ranking decides. Studio and the `lenient` fill keep their previous rules.
    const visionRan = pool.some((candidate) => candidate.moderationDecision !== null);
    const requireVerified = !input.allowUnverified && !input.lenient && !(job.vision.unattended && !visionRan);
    // VE2E-142: with no vision verdict to vouch for the clips, a video that never names the main subject (caption/hashtags/author) is off-topic
    // (Messi video -> church service). Gate on the subject's aliases; no on-subject candidate = this tier yields nothing and the next tier / ladder runs.
    if (job.vision.unattended && !visionRan && input.brief.subjectAliases?.length && !/^(0|false|off)$/i.test(process.env.APIFY_SUBJECT_GATE ?? "")) {
      const onSubject = pool.filter((candidate) => candidateSubjectMatch(candidate, input.brief) > 0);
      quality.rejected = { ...quality.rejected, off_subject: pool.length - onSubject.length };
      if (onSubject.length === 0) return fail("apify_no_on_subject_candidate");
      pool = onSubject;
    }
    let ranked = rankMediaCandidates(pool, input.brief, { usedExternalIds: input.usedExternalIds });
    if (input.brief.person) quality.personRejected = personRejectionCounts(ranked.map((entry) => entry.person));
    let phase2Failure = "";
    let decision: Extract<ReturnType<typeof decideMediaSelection>, { decision: "auto_select" }> | null = null;
    let toImport: ApifyCandidateResult | null = null;
    /** VE2E-146: the chosen post was downloaded by yt-dlp and is already registered (no Actor run, no second download). */
    let fetchedAsset: ApifyImportResponse["asset"] | null = null;
    let externalId = "";
    // VE2E-131: a phase-2 failure moves on to the next shortlisted candidate (max APIFY_MAX_PHASE2_CANDIDATES); the single-phase search is gone.
    for (let attempt = 0; attempt < APIFY_MAX_PHASE2_CANDIDATES; attempt += 1) {
      const next = decideMediaSelection(ranked, { requireVerifiedSemanticSignal: requireVerified, ...(input.lenient ? { relevanceThreshold: 0 } : {}) });
      if (next.decision === "needs_input") return fail(attempt === 0 ? `apify_abstained:${next.reason}` : phase2Failure);
      const chosen = byCandidateId.get(next.chosen.candidateId);
      if (!chosen) return fail("apify_no_usable_candidate");
      const id = next.chosen.externalId;
      const person = personQualityOf(next.ranked, next.chosen.candidateId);
      if (person) quality.person = person;
      const cleanliness = chosenCleanlinessDiagnostics(next.ranked, next.chosen.candidateId);
      if (cleanliness) quality.cleanliness = cleanliness;
      // Reserve synchronously (no await since the ranking above) so a concurrently sourced segment cannot pick the same clip.
      input.usedExternalIds.add(id);
      const library = await this.findLibraryAsset(projectId, input.platform, id);
      if (library) {
        quality.reusedLibraryAsset = true;
        job.usage.libraryReuses += 1;
        quality.frameCheck = await this.verifyVideoFrames(library, next.chosen, input.brief, userId, role, input.usedExternalIds, job.vision, input.sceneId, quality);
        if (quality.frameCheck === "rejected") return fail("apify_frames_rejected"); // the id stays reserved: this segment never re-picks the clip
        if ((await this.reframeCheck(library, input, job, quality)) === "reject" && !input.keepOverlayFlagged) return fail("apify_overlay_unavoidable"); // Auto: swap source (VE2E-67)
        return { ok: true, data: { asset: library, externalId: id, ledgerId: `${next.chosen.source}:${id}`, provenance: next.chosen.provenance.apify ?? null, platform: input.platform, quality } };
      }
      if (chosen.download) {
        decision = next;
        toImport = chosen;
        externalId = id;
        break;
      }
      if (chosen.deferredPostUrl && input.platform === "tiktok" && this.socialFetch && socialFetchEnabled("tiktok_download")) {
        const candidateWithQuery: MediaCandidate = { ...chosen.candidate, provenance: { ...chosen.candidate.provenance, query: input.keyword } };
        const fetched = await this.socialFetch.fetchPost({ platform: "tiktok", tool: "yt-dlp", url: chosen.deferredPostUrl, mediaType: "video", userId, role });
        quality.ossFetchMs = fetched.elapsedMs;
        const registered = fetched.ok ? await this.importFetchedPost(projectId, userId, role, input.platform, candidateWithQuery, fetched, { sceneId: input.sceneId }) : null;
        if (registered?.ok) {
          quality.downloader = "yt-dlp";
          decision = next;
          toImport = { ...chosen, candidate: candidateWithQuery };
          fetchedAsset = registered.data.asset;
          externalId = id;
          break;
        }
        quality.ossFetchCode = fetched.ok ? `register_failed:${registered && !registered.ok ? registered.code : "unknown"}` : fetched.code;
      }
      const phase2 = await this.fetchChosenPost(account, chosen, job, lang);
      if (phase2.ok) {
        quality.phase2 = "ok";
        if (quality.ossFetchCode) quality.downloader = "apify";
        decision = next;
        toImport = phase2.result;
        externalId = id;
        break;
      }
      quality.phase2 = "failed";
      phase2Failure = `apify_phase2_failed:${phase2.code}`;
      input.usedExternalIds.delete(id);
      ranked = ranked.filter((entry) => entry.candidate.candidateId !== next.chosen.candidateId);
    }
    if (!decision || !toImport) return fail(phase2Failure || "apify_no_usable_candidate");
    const release = () => input.usedExternalIds.delete(externalId);
    const importedId = toImport.candidate.externalId;
    const candidate: MediaCandidate = { ...toImport.candidate, provenance: { ...toImport.candidate.provenance, query: input.keyword } };
    const imported: ApifyOutcome<ApifyImportResponse> = fetchedAsset
      ? { ok: true, data: { asset: fetchedAsset } }
      : await this.importResult(projectId, userId, role, account, input.platform, { candidate, download: toImport.download }, { sceneId: input.sceneId });
    if (!imported.ok) {
      input.usedExternalIds.delete(importedId);
      job.failedIds.add(importedId);
      release();
      return fail(`apify_import_failed:${imported.code}:${String((imported as { message?: string }).message ?? "").slice(0, 120)}`);
    }
    quality.frameCheck = await this.verifyVideoFrames(imported.data.asset, candidate, input.brief, userId, role, input.usedExternalIds, job.vision, input.sceneId, quality);
    if (quality.frameCheck === "rejected") {
      // Unbind the rejected clip from its scene so a retry never reuses it through the library shortcut; the video id stays reserved.
      await this.media.assignScene(imported.data.asset.id, userId, role, null).catch(() => undefined);
      return fail("apify_frames_rejected");
    }
    if ((await this.reframeCheck(imported.data.asset, input, job, quality)) === "reject" && !input.keepOverlayFlagged) {
      // Auto + overlay_unavoidable (CR-SUBJECT-REFRAME Q5): same handling as a rejected candidate - unbind it and let the existing fallback pick another source.
      await this.media.assignScene(imported.data.asset.id, userId, role, null).catch(() => undefined);
      return fail("apify_overlay_unavoidable");
    }
    return {
      ok: true,
      data: { asset: imported.data.asset, externalId: importedId, ledgerId: `${candidate.source}:${importedId}`, provenance: candidate.provenance.apify ?? null, platform: input.platform, quality },
    };
  }

  /**
   * VE2E-146: registers a post that the media worker downloaded with yt-dlp straight into `_quarantine/`. Same asset shape as an Apify
   * import (origin `apify`, file name `apify-<platform>-<id>.<ext>` so the library shortcut finds it next time, `strip_audio`): the
   * candidate and its provenance come from the Apify search, only the transport differs, and the provenance says so (`downloader`).
   * The bytes still decide the type (sniffed here, re-hashed by registerAsset). A refused file is deleted from quarantine.
   */
  private async importFetchedPost(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    platform: ApifyPlatform,
    candidate: MediaCandidate,
    fetched: Extract<SocialFetchOutcome, { ok: true }>,
    options: { sceneId?: string | null },
  ): Promise<ApifyOutcome<ApifyImportResponse>> {
    const { result } = fetched;
    let sniffed: string | null = null;
    try {
      sniffed = sniffMediaMimeType(await readQuarantineHead(result.quarantineToken));
    } catch {
      sniffed = null;
    }
    if (!sniffed || !sniffed.startsWith("video/")) {
      await discardQuarantined(result.quarantineToken);
      return { ok: false, code: "UNSUPPORTED_MEDIA", message: "yt-dlp trả về file không phải video", status: 415 };
    }
    const safeId = candidate.externalId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || result.sha256.slice(0, 12);
    const registered = await this.media.registerAsset(projectId, userId, role, {
      quarantineToken: result.quarantineToken,
      kind: "video",
      originalFileName: `apify-${platform}-${safeId}.${extFor(sniffed)}`,
      mimeType: sniffed,
      checksumSha256: result.sha256,
      bytes: result.bytes,
      widthPx: result.probe?.width ?? candidate.widthPx ?? null,
      heightPx: result.probe?.height ?? candidate.heightPx ?? null,
      durationMs: result.probe?.durationMs ?? (candidate.durationSeconds ? Math.round(candidate.durationSeconds * 1000) : null),
      origin: "apify",
      license: APIFY_LICENSE,
      reusable: true,
      folderId: null,
      sceneId: options.sceneId ?? null,
      serverProvenance: {
        platform,
        rightsStatus: "owner_accepted_risk",
        apify: candidate.provenance.apify ?? null,
        attribution: candidate.attribution,
        query: candidate.provenance.query,
        downloader: { tool: result.tool.name, version: result.tool.version, profileVersion: result.tool.profileVersion, steps: fetched.steps.map((s) => ({ via: s.via, code: s.code, runs: s.runs.map((r) => r.step) })), elapsedMs: fetched.elapsedMs },
        importedAt: new Date().toISOString(),
        audioPolicy: "strip_audio",
      },
    });
    if (typeof registered === "string") {
      await discardQuarantined(result.quarantineToken);
      if (registered === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
      if (registered === "unsupported_media") return { ok: false, code: "UNSUPPORTED_MEDIA", message: "MIME không khớp loại asset", status: 415 };
      return { ok: false, code: "VALIDATION_FAILED", message: "Không thể lưu asset tải bằng yt-dlp vào project", status: 500 };
    }
    return { ok: true, data: { asset: registered } };
  }

  private async download(account: { encryptedSecret: string }, plan: ApifyDownloadPlan): Promise<SafeBinaryFetchResult | "plan_invalid"> {
    let url: URL;
    try { url = new URL(plan.url); } catch { return "plan_invalid"; }
    if (url.protocol !== "https:") return "plan_invalid";
    const mimePrefixes = plan.kind === "image" ? ["image/"] : ["video/", "application/octet-stream", "binary/octet-stream"];
    if (plan.policy === "public_web") {
      // Google image only: any public host, images only; safe-fetch blocks private/loopback/link-local, pins DNS, revalidates redirects.
      if (plan.kind !== "image") return "plan_invalid";
      return fetchBinarySafely(plan.url, { maxBytes: plan.maxBytes, allowedMimePrefixes: mimePrefixes });
    }
    // Suffix policies: the plan's suffixes must be from the fixed allowlist AND match the URL host (defence in depth over the sealed ref).
    const suffixes = plan.hostSuffixes;
    if (!suffixes.length || !suffixes.every((s) => ALL_ALLOWED_SUFFIXES.has(s)) || !hostMatchesSuffix(url.hostname, suffixes)) return "plan_invalid";
    if (plan.policy === "apify_api") {
      if (url.hostname.toLowerCase() !== "api.apify.com" || !url.pathname.startsWith("/v2/key-value-stores/")) return "plan_invalid";
      return fetchBinarySafely(plan.url, {
        maxBytes: plan.maxBytes,
        allowedHostSuffixes: suffixes,
        allowedMimePrefixes: mimePrefixes,
        hostScopedHeaders: { host: "api.apify.com", headers: { Authorization: `Bearer ${decryptSecret(account.encryptedSecret)}` } },
      });
    }
    return fetchBinarySafely(plan.url, { maxBytes: plan.maxBytes, allowedHostSuffixes: suffixes, allowedMimePrefixes: mimePrefixes });
  }

  private async importPlan(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    account: { id: string; encryptedSecret: string },
    source: { plan: ApifyDownloadPlan; platform: ApifyPlatform; meta: ImportRefPayload["meta"]; provenance: Record<string, unknown> },
    options: { folderId?: string | null; reusable?: boolean; sceneId?: string | null },
  ): Promise<ApifyOutcome<ApifyImportResponse>> {
    const downloaded = await this.download(account, source.plan);
    if (downloaded === "plan_invalid") return { ok: false, code: "SSRF_BLOCKED", message: "Nguồn tải Apify không nằm trong allowlist", status: 400 };
    if (!downloaded.ok) {
      if (downloaded.reason === "ssrf_blocked" || downloaded.reason === "domain_not_allowed") return { ok: false, code: "SSRF_BLOCKED", message: "Link tải Apify bị chặn bởi SSRF guard", status: 400 };
      if (downloaded.reason === "too_large") return { ok: false, code: "VALIDATION_FAILED", message: "File Apify vượt giới hạn dung lượng", status: 413 };
      if (downloaded.reason === "mime_not_allowed") return { ok: false, code: "UNSUPPORTED_MEDIA", message: "File Apify không phải loại media được phép", status: 415 };
      return { ok: false, code: "VALIDATION_FAILED", message: "Không tải được file từ Apify", status: 502 };
    }
    if (downloaded.buffer.byteLength === 0) return { ok: false, code: "VALIDATION_FAILED", message: "File tải về từ Apify rỗng", status: 502 };
    // Content-Type is only a hint: the bytes decide.
    const sniffed = sniffMediaMimeType(downloaded.buffer);
    const kind = source.plan.kind;
    if (!sniffed || !sniffed.startsWith(kind === "image" ? "image/" : "video/")) return { ok: false, code: "UNSUPPORTED_MEDIA", message: "Nội dung tải về không đúng loại media", status: 415 };

    const checksumSha256 = createHash("sha256").update(downloaded.buffer).digest("hex");
    const quarantined = await writeQuarantineFile(downloaded.buffer);
    const safeId = source.meta.externalId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || checksumSha256.slice(0, 12);
    const registered = await this.media.registerAsset(projectId, userId, role, {
      quarantineToken: quarantined.quarantineToken,
      kind,
      originalFileName: `apify-${source.platform}-${safeId}.${extFor(sniffed)}`,
      mimeType: sniffed,
      checksumSha256,
      bytes: downloaded.buffer.byteLength,
      widthPx: source.meta.widthPx,
      heightPx: source.meta.heightPx,
      durationMs: source.meta.durationSeconds !== null ? Math.round(source.meta.durationSeconds * 1000) || null : null,
      origin: "apify",
      license: APIFY_LICENSE,
      reusable: options.reusable ?? true,
      folderId: options.folderId ?? null,
      sceneId: options.sceneId ?? null,
      serverProvenance: { ...source.provenance, importedAt: new Date().toISOString(), audioPolicy: "strip_audio" },
    });
    if (registered === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    if (registered === "unsupported_media") return { ok: false, code: "UNSUPPORTED_MEDIA", message: "MIME không khớp loại asset", status: 415 };
    if (registered === "invalid" || registered === "quarantine_missing") return { ok: false, code: "VALIDATION_FAILED", message: "Không thể lưu asset Apify vào project", status: 500 };
    return { ok: true, data: { asset: registered } };
  }
}
