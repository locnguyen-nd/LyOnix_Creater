/**
 * VE2E-04: Pexels portrait photo/video search + import into the project media
 * library. Preview (search results) never downloads the full asset — only
 * thumbnail/preview URLs from Pexels' own CDN. Import always re-fetches the
 * authoritative photo/video detail by id from Pexels (never trusts a
 * client-supplied download URL), then downloads through the SSRF-safe,
 * domain-locked `fetchBinarySafely` before validating MIME/size/checksum and
 * handing off to `MediaService.registerAsset` (same quarantine/dedupe/
 * retention pipeline every other asset source uses).
 */
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ProviderError,
  getPexelsPhoto,
  getPexelsVideo,
  pexelsPhotoToMediaCandidate,
  pexelsVideoToMediaCandidate,
  pickPexelsVideoFile,
  searchPexelsPhotos,
  searchPexelsVideos,
} from "@lyonix/providers";
import {
  buildBoundedQueryVariants,
  canAccessProject,
  decideMediaSelection,
  deriveSceneBrief,
  detectScriptLanguageHeuristic,
  rankMediaCandidates,
  type MediaCandidate,
  type SceneBrief,
} from "@lyonix/domain";
import type {
  ErrorCode,
  MediaAssetKind,
  PexelsImportResponse,
  PexelsMediaType,
  PexelsSearchResponse,
} from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { MediaService } from "./media.service.js";
import { PrismaService } from "./prisma.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { fetchBinarySafely } from "./safe-binary-fetch.js";
import { writeQuarantineFile } from "./quarantine.js";

export type PexelsOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

/** Generic sanity ceiling for a single Pexels photo/video download (well above typical portrait-short assets). */
const MAX_PEXELS_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** Bounded per-variant candidate pool size for the auto-fill ranking flow (VE2E-15a) - same order of magnitude as `AUTO_FILL_CANDIDATE_POOL` in `apps/web/src/studio/media-selection.ts` so a real pool exists to rank, not just whatever the API returned first. */
const MEDIA_SEARCH_POOL_SIZE = 10;

const providerErrorMessage: Record<string, string> = {
  PROVIDER_AUTH_INVALID: "Khóa Pexels bị từ chối. Verify lại tài khoản.",
  PROVIDER_RATE_LIMITED: "Pexels giới hạn tốc độ, thử lại sau.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Pexels từ chối yêu cầu này (quyền/entitlement).",
  PROVIDER_TIMEOUT: "Yêu cầu Pexels hết thời gian chờ.",
  PROVIDER_SCHEMA_INVALID: "Pexels trả về dữ liệu không hợp lệ.",
};

/** VE2E-15a abstention reasons that reach here always come from a non-empty candidate pool (an empty pool short-circuits earlier to `PROVIDER_CAPABILITY_UNAVAILABLE`, matching the pre-existing "no results" contract), so `no_candidates` is unreachable at this call site. */
const abstentionOutcome = (reason: "below_relevance_threshold" | "unverified_relevance" | "rights_unresolved" | "not_auto_eligible" | "rejected_by_moderation"): { code: ErrorCode; message: string; status: number } => {
  if (reason === "below_relevance_threshold") {
    return { code: "MEDIA_RELEVANCE_BELOW_THRESHOLD", message: "Không tìm thấy media đủ liên quan cho scene (dưới ngưỡng), cần chọn thủ công trong Studio.", status: 422 };
  }
  if (reason === "unverified_relevance") {
    return { code: "MEDIA_RELEVANCE_UNVERIFIED", message: "Không có mô tả/kiểm duyệt hình ảnh để xác nhận media khớp chủ đề scene — cần chọn thủ công trong Studio.", status: 422 };
  }
  if (reason === "rights_unresolved") {
    return { code: "MEDIA_RIGHTS_UNRESOLVED", message: "Media phù hợp nhất cho scene có quyền sử dụng chưa rõ, cần Studio xác nhận thủ công.", status: 422 };
  }
  return { code: "VALIDATION_FAILED", message: "Media tốt nhất cho scene không thể tự động áp dụng (chưa qua kiểm duyệt/không đủ điều kiện), cần Studio xác nhận thủ công.", status: 422 };
};

const mapProviderError = (error: unknown): { code: ErrorCode; message: string; status: number; retryable: boolean } => {
  if (error instanceof ProviderError) {
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_AUTH_INVALID";
    return { code: error.code, message: providerErrorMessage[error.code] ?? "Pexels từ chối yêu cầu", status: switchable ? 429 : 502, retryable: error.retryable };
  }
  return { code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi Pexels", status: 502, retryable: true };
};

export type SearchInput = { providerAccountId: string; type: PexelsMediaType; query: string; page?: number; perPage?: number };
export type ImportInput = { providerAccountId: string; type: PexelsMediaType; externalId: string; folderId?: string | null; reusable?: boolean; sceneId?: string | null };
export type AutoImportForSceneInput = {
  providerAccountId: string;
  sceneId: string;
  query: string;
  folderId?: string | null;
  /** VE2E-15a: real narrative-beat scene brief. When omitted, a minimal single-phrase brief is synthesized from `query` alone so older callers keep working unchanged. */
  sceneBrief?: SceneBrief;
  /** External ids already assigned to another scene in the same run - continuity gate, same contract as `usedExternalIds` in `apps/web/src/studio/media-selection.ts`. */
  usedExternalIds?: readonly string[];
};

@Injectable()
export class PexelsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(ProviderAccountsService) private readonly providerAccounts: ProviderAccountsService,
  ) {}

  private async assertProjectAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return false;
    const grants = await this.grants.forUser(userId, role);
    return canAccessProject(role, grants, projectId);
  }

  /** Any non-deleted `pexels`/`visual` account, verified (or fake in test) — same authorization shape as `ScriptGenerationService`/`ElevenLabsVoiceService`. */
  private async usableAccount(providerAccountId: string): Promise<PexelsOutcome<{ id: string; encryptedSecret: string }>> {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, deletedAt: null } });
    if (!account) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản provider không tồn tại hoặc đã bị xóa", status: 503 };
    if (account.role !== "visual" || account.provider !== "pexels") {
      return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Tài khoản không phải Pexels (visual)", status: 503 };
    }
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản Pexels chưa verify", status: 503 };
    return { ok: true, data: { id: account.id, encryptedSecret: account.encryptedSecret } };
  }

  async search(projectId: string, userId: string, role: "admin" | "staff", input: SearchInput): Promise<PexelsOutcome<PexelsSearchResponse>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!input.query.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu từ khóa tìm kiếm" };
    const apiKey = decryptSecret(account.data.encryptedSecret);
    try {
      const searchOptions = { ...(input.page !== undefined ? { page: input.page } : {}), ...(input.perPage !== undefined ? { perPage: input.perPage } : {}) };
      if (input.type === "photo") {
        const photos = await searchPexelsPhotos(apiKey, input.query, searchOptions);
        return {
          ok: true,
          data: {
            type: "photo",
            query: input.query,
            page: input.page ?? 1,
            perPage: input.perPage ?? 15,
            photos: photos.map((p) => ({ externalId: p.externalId, width: p.width, height: p.height, attribution: p.attribution, thumbnailUrl: p.thumbnailUrl, previewUrl: p.previewUrl })),
            videos: [],
          },
        };
      }
      const videos = await searchPexelsVideos(apiKey, input.query, searchOptions);
      return {
        ok: true,
        data: {
          type: "video",
          query: input.query,
          page: input.page ?? 1,
          perPage: input.perPage ?? 15,
          photos: [],
          videos: videos.map((v) => ({
            externalId: v.externalId,
            width: v.width,
            height: v.height,
            durationSeconds: v.durationSeconds,
            attribution: v.attribution,
            thumbnailUrl: v.thumbnailUrl,
            fileOptions: v.fileOptions.map((f) => ({ quality: f.quality, width: f.width, height: f.height, fileType: f.fileType })),
          })),
        },
      };
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
  }

  async import(projectId: string, userId: string, role: "admin" | "staff", input: ImportInput): Promise<PexelsOutcome<PexelsImportResponse>> {
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    if (!input.externalId.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu externalId để import" };
    const apiKey = decryptSecret(account.data.encryptedSecret);

    let downloadUrl: string;
    let kind: MediaAssetKind;
    let widthPx: number | null;
    let heightPx: number | null;
    let durationMs: number | null;
    let attribution: { photographerName: string; photographerUrl: string; pexelsPageUrl: string };
    let originalFileName: string;
    try {
      if (input.type === "photo") {
        const detail = await getPexelsPhoto(apiKey, input.externalId);
        if (!detail.downloadUrl) return { ok: false, code: "PROVIDER_SCHEMA_INVALID", message: "Pexels không trả về link tải ảnh", status: 502 };
        downloadUrl = detail.downloadUrl;
        kind = "image";
        widthPx = detail.width || null;
        heightPx = detail.height || null;
        durationMs = null;
        attribution = detail.attribution;
        originalFileName = `pexels-${detail.externalId}.jpg`;
      } else {
        const detail = await getPexelsVideo(apiKey, input.externalId);
        const file = pickPexelsVideoFile(detail.fileOptions);
        if (!file) return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Pexels không có file mp4 phù hợp cho video này", status: 502 };
        downloadUrl = file.link;
        kind = "video";
        widthPx = file.width || null;
        heightPx = file.height || null;
        durationMs = Math.round(detail.durationSeconds * 1000) || null;
        attribution = detail.attribution;
        originalFileName = `pexels-${detail.externalId}.mp4`;
      }
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }

    const downloaded = await fetchBinarySafely(downloadUrl, { maxBytes: MAX_PEXELS_DOWNLOAD_BYTES, allowedHostSuffix: ".pexels.com" });
    if (!downloaded.ok) {
      if (downloaded.reason === "ssrf_blocked" || downloaded.reason === "domain_not_allowed") {
        return { ok: false, code: "SSRF_BLOCKED", message: "Link tải Pexels bị chặn bởi SSRF guard", status: 400 };
      }
      return { ok: false, code: "VALIDATION_FAILED", message: "Không tải được file từ Pexels", status: 502 };
    }
    if (downloaded.buffer.byteLength === 0) return { ok: false, code: "VALIDATION_FAILED", message: "File tải về từ Pexels rỗng", status: 502 };

    const checksumSha256 = createHash("sha256").update(downloaded.buffer).digest("hex");
    const quarantined = await writeQuarantineFile(downloaded.buffer);
    const registered = await this.media.registerAsset(projectId, userId, role, {
      quarantineToken: quarantined.quarantineToken,
      kind,
      originalFileName,
      mimeType: downloaded.mimeType || (kind === "image" ? "image/jpeg" : "video/mp4"),
      checksumSha256,
      bytes: downloaded.buffer.byteLength,
      widthPx,
      heightPx,
      durationMs,
      origin: "pexels",
      license: "Pexels License (https://www.pexels.com/license/)",
      reusable: input.reusable ?? true,
      folderId: input.folderId ?? null,
      sceneId: input.sceneId ?? null,
      attribution,
    });
    if (registered === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    if (registered === "invalid" || registered === "unsupported_media" || registered === "quarantine_missing") {
      return { ok: false, code: "VALIDATION_FAILED", message: "Không thể lưu asset Pexels vào project", status: 500 };
    }
    return { ok: true, data: { asset: registered } };
  }

  /**
   * VE2E-15a: fetches a bounded candidate pool for one query variant/media type through the
   * shared Postgres-backed concurrency+cooldown gate (mirrors the VE2E-12 content-account
   * pattern in `provider-accounts.service.ts`, reused here for the `"visual"` role instead of a
   * second mechanism). A denied slot (concurrency ceiling or an active cooldown from a prior
   * 429) stops fan-out immediately rather than queueing more calls; a live 429 opens a new
   * cooldown and stops the remaining variants in this call too.
   */
  private async collectCandidatePool(
    apiKey: string,
    accountId: string,
    variants: readonly string[],
    type: PexelsMediaType,
    queriedAt: string,
  ): Promise<{ ok: true; candidates: MediaCandidate[] } | { ok: false; error: unknown }> {
    const candidates: MediaCandidate[] = [];
    for (const variant of variants) {
      const acquired = await this.providerAccounts.acquireContentRequestSlot(accountId, new Date(), 4, "visual");
      if (!acquired) break;
      try {
        if (type === "video") {
          const videos = await searchPexelsVideos(apiKey, variant, { perPage: MEDIA_SEARCH_POOL_SIZE });
          candidates.push(...videos.map((v) => pexelsVideoToMediaCandidate(v, { query: variant, providerAccountId: accountId, queriedAt })));
        } else {
          const photos = await searchPexelsPhotos(apiKey, variant, { perPage: MEDIA_SEARCH_POOL_SIZE });
          candidates.push(...photos.map((p) => pexelsPhotoToMediaCandidate(p, { query: variant, providerAccountId: accountId, queriedAt })));
        }
      } catch (error) {
        await this.providerAccounts.releaseContentRequestSlot(accountId, "visual").catch(() => undefined);
        if (error instanceof ProviderError && error.code === "PROVIDER_RATE_LIMITED") {
          await this.providerAccounts.cooldownContentAccount(accountId, error.retryAfterMs, new Date(), "visual").catch(() => undefined);
        }
        return { ok: false, error };
      }
      await this.providerAccounts.releaseContentRequestSlot(accountId, "visual").catch(() => undefined);
    }
    const seen = new Set<string>();
    return { ok: true, candidates: candidates.filter((c) => (seen.has(c.candidateId) ? false : (seen.add(c.candidateId), true))) };
  }

  /**
   * VE2E-06/VE2E-15a Auto media-preparing step. Fetches a bounded, ranked candidate pool
   * (portrait video first - short-form default - falling back to photo only when the video
   * pool is entirely empty, same type preference as before) instead of blindly importing the
   * API's first result, and only imports the top-ranked candidate when `decideMediaSelection`
   * says `auto_select`; a weak-relevance or rights-unresolved top result routes to a distinct
   * `needs_input`-classified error instead of silently importing a poor match (spec §5). Never
   * fabricates a placeholder asset when the provider pool comes back empty. Only used by the
   * trusted background `WorkflowRunnerService`, not exposed as its own HTTP endpoint (callers
   * needing manual pick-from-results control should keep using `search()` + `import()`).
   */
  async autoImportForScene(projectId: string, userId: string, role: "admin" | "staff", input: AutoImportForSceneInput): Promise<PexelsOutcome<PexelsImportResponse & { externalId: string }>> {
    if (!(await this.assertProjectAccess(projectId, userId, role))) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    const account = await this.usableAccount(input.providerAccountId);
    if (!account.ok) return account;
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery && !input.sceneBrief) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu từ khóa tìm kiếm cho scene" };
    const apiKey = decryptSecret(account.data.encryptedSecret);
    const accountId = account.data.id;

    // Real narrative-beat brief when the caller has one (WorkflowRunnerService, from the approved ScriptDraftV2); otherwise a minimal single-phrase brief synthesized from `query` alone, so older/manual callers keep the original one-query behavior.
    const brief: SceneBrief = input.sceneBrief ?? deriveSceneBrief(
      { language: detectScriptLanguageHeuristic(trimmedQuery), scenes: [{ sceneId: input.sceneId, narration: "", screenText: "", visualQuery: trimmedQuery, durationHintMs: 5000 }] },
      0,
    );
    const variants = buildBoundedQueryVariants(brief);
    const queriedAt = new Date().toISOString();
    const usedExternalIds = new Set(input.usedExternalIds ?? []);

    const videoPool = await this.collectCandidatePool(apiKey, accountId, variants, "video", queriedAt);
    if (!videoPool.ok) return { ok: false, ...mapProviderError(videoPool.error) };
    let pool = videoPool.candidates;
    if (pool.length === 0) {
      const photoPool = await this.collectCandidatePool(apiKey, accountId, variants, "photo", queriedAt);
      if (!photoPool.ok) return { ok: false, ...mapProviderError(photoPool.error) };
      pool = photoPool.candidates;
    }
    if (pool.length === 0) {
      return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: `Pexels không có kết quả nào cho scene (query: "${trimmedQuery || brief.phrases[0] || ""}")`, status: 502 };
    }

    const ranked = rankMediaCandidates(pool, brief, { usedExternalIds });
    // Auto is fully unattended (no human reviews the pick before render), so a photo candidate with
    // no real relevance evidence at all (no alt text, no vision findings) must never be
    // auto-selected on continuity/quality/cost alone. Video is exempted from this guard - Pexels'
    // video search returns no descriptive text at all, and real per-frame verification needs
    // media-worker frame extraction that does not exist yet (see requireVerifiedSemanticSignal's
    // own doc comment in media-ranking.ts) - so it keeps its prior (pre-VE2E-15a-hardening) behavior.
    const decision = decideMediaSelection(ranked, { requireVerifiedSemanticSignal: true });
    if (decision.decision === "needs_input") {
      if (decision.reason === "no_candidates") {
        // Unreachable in practice (guarded by the `pool.length === 0` check above) - kept only so this switch stays exhaustive if the guard above is ever refactored away.
        return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: `Pexels không có kết quả nào cho scene (query: "${trimmedQuery}")`, status: 502 };
      }
      return { ok: false, ...abstentionOutcome(decision.reason) };
    }

    const imported = await this.import(projectId, userId, role, {
      providerAccountId: input.providerAccountId,
      type: decision.chosen.mediaType,
      externalId: decision.chosen.externalId,
      sceneId: input.sceneId,
      reusable: true,
      ...(input.folderId ? { folderId: input.folderId } : {}),
    });
    if (!imported.ok) return imported;
    // `externalId` is internal-only (this method is never exposed as its own HTTP endpoint) - lets `WorkflowRunnerService` track cross-scene continuity without re-deriving it from the registered asset (which is identified by checksum, not the provider's external id).
    return { ok: true, data: { asset: imported.data.asset, externalId: decision.chosen.externalId } };
  }
}
