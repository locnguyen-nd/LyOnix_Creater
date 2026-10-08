import { Inject, Injectable } from "@nestjs/common";
import { selectSocialSearchItems, type SocialSearchRejectReason } from "@lyonix/domain";
import type { SocialFetchPlatform, SocialFetchTool, SocialSearchItem } from "@lyonix/media-jobs";
import { MediaService, sniffMediaMimeType } from "./media.service.js";
import { PrismaService } from "./prisma.service.js";
import { discardQuarantined, readQuarantineHead, SocialFetchService, type SocialFetchOutcome } from "./social-fetch.service.js";

/** Same rights wording as the Apify path: social footage is owner_accepted_risk (DEC-2026-10-08-SOCIAL-FETCH-OSS), never rights-cleared. */
export const SOCIAL_LICENSE = "Social media found and downloaded with yt-dlp / gallery-dl - owner_accepted_risk (not rights-cleared); audio always stripped";

const SEARCH_LIMIT = 15;
/** Downloads tried per segment (each is a worker job + bandwidth); the rest of the ladder covers the remainder. */
const MAX_DOWNLOADS = 2;

export const shortsMaxSeconds = (env: NodeJS.ProcessEnv = process.env): number => {
  const value = Number(env.MEDIA_SHORTS_MAX_SECONDS);
  return Number.isFinite(value) && value >= 15 && value <= 600 ? value : 180;
};

const extFor = (mime: string) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" } as Record<string, string>)[mime] ?? "bin";
const safeIdOf = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
/** Ledger id of a social source (`social:<platform>:<id>`), the same shape as Apify's `apify:<platform>:<id>`. */
export const socialLedgerId = (platform: string, id: string) => `social:${platform}:${id}`;
export const socialLedgerIdFromFileName = (fileName: string): string | null => {
  const match = /^social-([a-z]+)-([A-Za-z0-9_-]+)\.[a-z0-9]+$/.exec(fileName);
  return match ? socialLedgerId(match[1]!, match[2]!) : null;
};

export type SocialAsset = { id: string; kind: "video" | "image"; durationMs: number | null };
export type SocialSourceDiagnostics = {
  platform: SocialFetchPlatform;
  tool: SocialFetchTool;
  queries: string[];
  considered: number;
  passed: number;
  rejected: Partial<Record<SocialSearchRejectReason, number>>;
  downloads: Array<{ externalId: string; code: string | null; ms: number }>;
};
export type SocialImportOutcome =
  | { ok: true; data: { asset: SocialAsset; externalId: string; ledgerId: string; sourceUrl: string; author: string | null; reused: boolean; diagnostics: SocialSourceDiagnostics } }
  | { ok: false; reason: string; diagnostics: SocialSourceDiagnostics };

/**
 * VE2E-147/148 (CR-MEDIA-OSS-FETCH §3.4): one segment's source from a metadata search + yt-dlp / gallery-dl download (YouTube Shorts,
 * Pinterest, X). Search (up to 2 queries) -> `selectSocialSearchItems` (used / type / duration / orientation / subject gate) -> for the best
 * <= MAX_DOWNLOADS results: claim the id in the LIVE ledger set (same tick as the check), reuse the project's copy when it was imported
 * before, else download + register (`origin: social`, `social-<platform>-<id>.<ext>`, strip_audio, provenance with tool + URL).
 * A failed download releases its claim and tries the next result. Never throws.
 *
 * Honest limit: no plan-time vision / overlay check here (the Apify path has one); the render path still reframes `social` footage
 * (reframe policy default `apify,social`) and the quality gate still applies.
 */
@Injectable()
export class SocialSourceService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(SocialFetchService) private readonly socialFetch: SocialFetchService,
  ) {}

  async autoImportForSegment(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    input: {
      platform: SocialFetchPlatform;
      tool: SocialFetchTool;
      queries: string[];
      mediaType: "video" | "image";
      segmentDurationSeconds: number;
      /** Plain platform ids already used by the job (live set shared with the other tiers). */
      usedExternalIds: Set<string>;
      subjectAliases: string[];
      keywords: string[];
      sceneId: string;
    },
  ): Promise<SocialImportOutcome> {
    const queries = [...new Set(input.queries.map((q) => q.trim()).filter(Boolean))].slice(0, 2);
    const diagnostics: SocialSourceDiagnostics = { platform: input.platform, tool: input.tool, queries, considered: 0, passed: 0, rejected: {}, downloads: [] };
    const fail = (reason: string): SocialImportOutcome => ({ ok: false, reason, diagnostics });
    if (queries.length === 0) return fail("no_query");

    let lastReason = "no_candidate";
    for (const query of queries) {
      const found = await this.socialFetch.search({ platform: input.platform, tool: input.tool, query, limit: SEARCH_LIMIT, mediaType: input.mediaType, userId, role });
      if (!found.ok) {
        lastReason = `search:${found.code}`;
        if (found.code === "FETCH_BREAKER_OPEN" || found.code === "FETCH_WORKER_UNAVAILABLE" || found.code === "FETCH_TOOL_MISSING") return fail(lastReason);
        continue;
      }
      diagnostics.considered += found.items.length;
      const selection = selectSocialSearchItems(found.items, {
        mediaType: input.mediaType,
        usedIds: input.usedExternalIds,
        minDurationSeconds: input.segmentDurationSeconds,
        maxDurationSeconds: shortsMaxSeconds(),
        subjectAliases: input.subjectAliases,
        keywords: [query, ...input.keywords],
      });
      diagnostics.passed += selection.passed.length;
      for (const [reason, count] of Object.entries(selection.rejectCounts)) diagnostics.rejected[reason as SocialSearchRejectReason] = (diagnostics.rejected[reason as SocialSearchRejectReason] ?? 0) + (count ?? 0);
      if (selection.passed.length === 0) {
        lastReason = "no_usable_candidate";
        continue;
      }
      for (const { item } of selection.passed.slice(0, MAX_DOWNLOADS)) {
        const id = item.externalId!;
        if (input.usedExternalIds.has(id)) continue;
        input.usedExternalIds.add(id); // claim before any await
        const reused = await this.findLibraryAsset(projectId, input.platform, id);
        if (reused) return { ok: true, data: { asset: reused, externalId: id, ledgerId: socialLedgerId(input.platform, id), sourceUrl: item.url, author: item.uploader ?? item.channel, reused: true, diagnostics } };
        const fetched = await this.socialFetch.fetchPost({ platform: input.platform, tool: input.tool, url: item.url, mediaType: input.mediaType, userId, role });
        diagnostics.downloads.push({ externalId: id, code: fetched.ok ? null : fetched.code, ms: fetched.elapsedMs });
        const registered = fetched.ok ? await this.register(projectId, userId, role, input.platform, item, query, fetched, input.sceneId) : null;
        if (registered && registered !== "rejected") {
          return { ok: true, data: { asset: registered, externalId: id, ledgerId: socialLedgerId(input.platform, id), sourceUrl: item.url, author: item.uploader ?? item.channel, reused: false, diagnostics } };
        }
        input.usedExternalIds.delete(id);
        lastReason = fetched.ok ? "register_failed" : `download:${fetched.code}`;
        if (!fetched.ok && (fetched.code === "FETCH_BREAKER_OPEN" || fetched.code === "FETCH_WORKER_UNAVAILABLE" || fetched.code === "FETCH_TOOL_MISSING")) return fail(lastReason);
      }
    }
    return fail(lastReason);
  }

  private async findLibraryAsset(projectId: string, platform: string, externalId: string): Promise<SocialAsset | null> {
    const safeId = safeIdOf(externalId);
    if (!safeId) return null;
    try {
      const row = await this.prisma.mediaAssetVersion.findFirst({
        where: { projectId, deletedAt: null, parentMediaAssetVersionId: null, originalFileName: { startsWith: `social-${platform}-${safeId}.` } },
        orderBy: { createdAt: "desc" },
      });
      return row && (row.kind === "video" || row.kind === "image") ? { id: row.id, kind: row.kind, durationMs: row.durationMs } : null;
    } catch {
      return null;
    }
  }

  private async register(
    projectId: string,
    userId: string,
    role: "admin" | "staff",
    platform: SocialFetchPlatform,
    item: SocialSearchItem,
    query: string,
    fetched: Extract<SocialFetchOutcome, { ok: true }>,
    sceneId: string,
  ): Promise<SocialAsset | "rejected"> {
    const { result } = fetched;
    let sniffed: string | null = null;
    try {
      sniffed = sniffMediaMimeType(await readQuarantineHead(result.quarantineToken));
    } catch {
      sniffed = null;
    }
    if (!sniffed || !sniffed.startsWith(item.mediaType === "image" ? "image/" : "video/")) {
      await discardQuarantined(result.quarantineToken);
      return "rejected";
    }
    const id = safeIdOf(item.externalId ?? "") || result.sha256.slice(0, 12);
    const registered = await this.media.registerAsset(projectId, userId, role, {
      quarantineToken: result.quarantineToken,
      kind: item.mediaType,
      originalFileName: `social-${platform}-${id}.${extFor(sniffed)}`,
      mimeType: sniffed,
      checksumSha256: result.sha256,
      bytes: result.bytes,
      widthPx: result.probe?.width ?? item.width ?? result.info.width ?? null,
      heightPx: result.probe?.height ?? item.height ?? result.info.height ?? null,
      durationMs: item.mediaType === "image" ? null : result.probe?.durationMs ?? (item.durationSeconds ? Math.round(item.durationSeconds * 1000) : null),
      origin: "social",
      license: SOCIAL_LICENSE,
      reusable: true,
      folderId: null,
      sceneId,
      serverProvenance: {
        platform,
        rightsStatus: "owner_accepted_risk",
        decision: "DEC-2026-10-08-SOCIAL-FETCH-OSS",
        sourceUrl: item.url,
        externalId: item.externalId,
        author: item.uploader ?? item.channel ?? null,
        title: item.title,
        query,
        downloader: { tool: result.tool.name, version: result.tool.version, profileVersion: result.tool.profileVersion, steps: fetched.steps.map((s) => ({ via: s.via, code: s.code, runs: s.runs.map((r) => r.step) })), elapsedMs: fetched.elapsedMs },
        importedAt: new Date().toISOString(),
        audioPolicy: "strip_audio",
      },
    });
    if (typeof registered === "string") {
      await discardQuarantined(result.quarantineToken);
      return "rejected";
    }
    return { id: registered.id, kind: registered.kind === "image" ? "image" : "video", durationMs: registered.durationMs };
  }
}
