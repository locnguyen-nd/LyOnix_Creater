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
 * (project, platform) single-flight guard and a 15-minute result cache avoid paying twice for the same query.
 */
import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  APIFY_HOST_ALLOWLIST,
  ProviderError,
  hostMatchesSuffix,
  isApifyPlatform,
  searchApify,
  type ApifyCandidateResult,
  type ApifyDeps,
  type ApifyDownloadPlan,
  type ApifyLang,
  type ApifyPlatform,
  type ApifySearchOutcome,
} from "@lyonix/providers";
import { canAccessProject, canWriteProjectResource } from "@lyonix/domain";
import type { ApifyCandidateResponse, ApifyImportResponse, ApifySearchResponse, ErrorCode } from "@lyonix/contracts";
import { GrantsService } from "./grants.service.js";
import { MediaService, sniffMediaMimeType } from "./media.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";
import { fetchBinarySafely, type SafeBinaryFetchResult } from "./safe-binary-fetch.js";
import { writeQuarantineFile } from "./quarantine.js";

export type ApifyOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

const IMPORT_REF_TTL_MS = 30 * 60 * 1000;
const RESULT_CACHE_TTL_MS = 15 * 60 * 1000;
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
  private readonly inflight = new Set<string>();
  /** Test seam: stubbed Apify API. Production leaves this undefined (global fetch). */
  apifyDeps: ApifyDeps | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
    @Inject(MediaService) private readonly media: MediaService,
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
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản Apify chưa verify", status: 503 };
    return { ok: true, data: { id: account.id, encryptedSecret: account.encryptedSecret } };
  }

  /** Server-internal search (also used by MediaPlanService, VE2E-46): raw candidates incl. download plans. Access is checked by the caller-facing wrappers. */
  async searchRaw(
    projectId: string,
    account: { id: string; encryptedSecret: string },
    input: { platform: ApifyPlatform; keyword: string; lang: ApifyLang; limit?: number },
  ): Promise<ApifyOutcome<ApifySearchOutcome>> {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 10), 1), 20);
    const keyword = input.keyword.trim().replace(/\s+/g, " ");
    const cacheKey = createHash("sha256").update([account.id, input.platform, input.lang, limit, keyword.toLowerCase()].join("\u0000")).digest("hex");
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.at < RESULT_CACHE_TTL_MS) return { ok: true, data: cached.outcome };
    // One Actor run at a time per (project, platform): a second concurrent search is refused, not queued.
    const flightKey = `${projectId}:${input.platform}`;
    if (this.inflight.has(flightKey)) return { ok: false, code: "PROVIDER_RATE_LIMITED", message: "Đang có một lượt tìm Apify cho nền tảng này, thử lại sau.", status: 429, retryable: true };
    this.inflight.add(flightKey);
    try {
      const outcome = await searchApify(decryptSecret(account.encryptedSecret), { platform: input.platform, keyword, lang: input.lang, limit, providerAccountId: account.id }, this.apifyDeps);
      this.cache.set(cacheKey, { at: now, outcome });
      if (this.cache.size > 200) for (const [key, value] of this.cache) if (now - value.at >= RESULT_CACHE_TTL_MS) this.cache.delete(key);
      return { ok: true, data: outcome };
    } catch (error) {
      return { ok: false, ...providerFailure(error) };
    } finally {
      this.inflight.delete(flightKey);
    }
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
