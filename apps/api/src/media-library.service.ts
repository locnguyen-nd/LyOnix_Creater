/**
 * VE2E-135 (CR-MEDIA-SLA-2026-10-07 3.1 L0 / 3.5): prepared media library, on top of the existing `MediaAssetVersion` rows.
 *
 * No new table: a clip is "in the library" when `provenance.library` (domain `LibraryTags`) is present. L0 (`findForSegment`)
 * matches a segment's keywords/subject against those tags (no embeddings yet - an embedding score can later be added next to
 * `scoreLibraryMatch`), skips clips used inside the repeat window (7 days / 20 most recent videos) and falls through (returns null)
 * on an empty or untagged library so the old tiers run exactly as before. Files stay local; clips entering through the background
 * prefetch are `working` class with the 7-day TTL, extended each time a clip is reused, and `sweepExpired` removes the expired ones.
 *
 * Scope: the job's own project. This system has no project->channel link, so "same channel" = same project (caller may widen later
 * by passing more project ids). Repeat guard today = external id + sha256 checksum (+ author as a soft penalty): a repost with a
 * different checksum is NOT caught until VE2E-91 registers a perceptual-hash guard through `registerRepeatGuard`.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma } from "@lyonix/db";
import {
  AUTHOR_REPEAT_PENALTY,
  blockedByRepeatWindow,
  buildLibraryTags,
  computeExpiresAt,
  libraryMinScoreFromEnv,
  parseSegmentKeywords,
  readLibraryTags,
  repeatWindowFromEnv,
  scoreLibraryMatch,
  subjectProfileOf,
  usedInWindow,
  type LibraryQuery,
  type LibraryTags,
  type RepeatCandidate,
  type RepeatGuard,
} from "@lyonix/domain";
import { mediaRoot } from "./handoff-workspace.js";
import { PrismaService } from "./prisma.service.js";

export type LibraryLedger = { jobKey: string; assetIds: Set<string>; externalIds: Set<string>; apifyPlainIds: Set<string> };
export type LibrarySegment = { keywords?: unknown; subject?: string | null; durationMs: number; visualKind?: "video" | "image" };
export type LibraryHit = { assetId: string; kind: "video"; durationMs: number | null; externalId: string | null; provider: "apify" | "pexels" | "social" | undefined; score: number; author: string | null };

const plainId = (id: string) => (id.startsWith("apify:") ? id.split(":").slice(2).join(":") : id);

/** Kill switch: `MEDIA_LIBRARY_L0=0` turns the L0 lookup off (default on; an empty library costs one indexed query). */
export const libraryL0Enabled = (env: Record<string, string | undefined> = process.env): boolean => env.MEDIA_LIBRARY_L0 !== "0";

/** Query terms of a segment: the ja/en/broad keywords and the video subject + aliases (VE2E-88/89). */
export function libraryQueryOf(segment: LibrarySegment): LibraryQuery {
  const keywords = parseSegmentKeywords(segment.keywords);
  const profile = subjectProfileOf(segment);
  return { ja: keywords.ja, en: keywords.en, broad: keywords.broad, subject: profile.subject ?? segment.subject?.trim() ?? null, aliases: profile.aliases };
}

@Injectable()
export class MediaLibraryService {
  private readonly logger = new Logger(MediaLibraryService.name);
  private readonly guards: RepeatGuard[] = [];

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** VE2E-91 hook: an extra repeat check (perceptual hash) consulted after the external id / checksum rules. */
  registerRepeatGuard(guard: RepeatGuard): void {
    this.guards.push(guard);
  }

  private async candidates(projectId: string, now: Date) {
    const take = Math.max(1, Math.min(2000, Number(process.env.MEDIA_LIBRARY_MAX_SCAN) || 500));
    const rows = await this.prisma.mediaAssetVersion.findMany({
      where: { projectId, deletedAt: null, parentMediaAssetVersionId: null, reusable: true, kind: "video", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { createdAt: "desc" },
      take,
    });
    const out: Array<{ row: (typeof rows)[number]; tags: LibraryTags; candidate: RepeatCandidate }> = [];
    for (const row of rows) {
      const tags = readLibraryTags(row.provenance);
      if (!tags) continue;
      out.push({ row, tags, candidate: { assetId: row.id, checksumSha256: row.checksumSha256, externalId: tags.externalId, author: tags.author, usages: tags.usages } });
    }
    return out;
  }

  /**
   * L0: the best unused library clip for the segment with score >= `MEDIA_LIBRARY_MIN_SCORE` (default 0.6), or null. Claims the clip in
   * the ledger synchronously (no await between the final check and the claim), records the usage and extends a working clip's TTL.
   * Never throws: any error = null (the old tiers run).
   */
  async findForSegment(projectId: string, segment: LibrarySegment, ledger: LibraryLedger, options: { now?: Date } = {}): Promise<LibraryHit | null> {
    if (!libraryL0Enabled() || (segment.visualKind ?? "video") !== "video") return null;
    try {
      const now = options.now ?? new Date();
      const all = await this.candidates(projectId, now);
      if (all.length === 0) return null;
      const query = libraryQueryOf(segment);
      const threshold = libraryMinScoreFromEnv();
      const window = usedInWindow(all.map((entry) => entry.candidate), repeatWindowFromEnv(), now);
      const scored: Array<{ entry: (typeof all)[number]; score: number }> = [];
      for (const entry of all) {
        if (ledger.assetIds.has(entry.row.id) || (entry.tags.externalId && (ledger.externalIds.has(entry.tags.externalId) || ledger.apifyPlainIds.has(plainId(entry.tags.externalId))))) continue;
        if (blockedByRepeatWindow(entry.candidate, window)) continue;
        let score = scoreLibraryMatch(query, entry.tags);
        if (entry.tags.author && window.authors.has(entry.tags.author)) score = Math.round((score - AUTHOR_REPEAT_PENALTY) * 1000) / 1000;
        if (score < threshold) continue;
        let repeat = false;
        for (const guard of this.guards) {
          if (await guard(entry.candidate, window.used)) {
            repeat = true;
            break;
          }
        }
        if (!repeat) scored.push({ entry, score });
      }
      if (scored.length === 0) return null;
      const needMs = segment.durationMs;
      const fits = (d: number | null) => (d === null || d >= needMs ? 1 : 0);
      scored.sort((a, b) => b.score - a.score || fits(b.entry.row.durationMs) - fits(a.entry.row.durationMs) || Date.parse(a.entry.tags.addedAt) - Date.parse(b.entry.tags.addedAt));
      const best = scored.find(({ entry }) => !ledger.assetIds.has(entry.row.id));
      if (!best) return null;
      const { row, tags } = best.entry;
      // Claim (same tick as the check above) so a segment sourced in parallel cannot take this clip.
      ledger.assetIds.add(row.id);
      if (tags.externalId) {
        ledger.externalIds.add(tags.externalId);
        ledger.apifyPlainIds.add(plainId(tags.externalId));
      }
      await this.recordUse(row, tags, ledger.jobKey, now).catch((error) => this.logger.warn(`library usage not recorded: ${String(error)}`));
      return { assetId: row.id, kind: "video", durationMs: row.durationMs, externalId: tags.externalId, provider: row.origin === "apify" ? "apify" : row.origin === "pexels" ? "pexels" : row.origin === "social" ? "social" : undefined, score: best.score, author: tags.author };
    } catch (error) {
      this.logger.warn(`library L0 lookup failed, falling through: ${String(error)}`);
      return null;
    }
  }

  private async recordUse(row: { id: string; provenance: unknown; retentionClass: string }, tags: LibraryTags, jobKey: string, now: Date) {
    const usages = [...tags.usages.filter((usage) => usage.jobKey !== jobKey), { jobKey, at: now.toISOString() }].slice(-50);
    const provenance = { ...((row.provenance && typeof row.provenance === "object" ? row.provenance : {}) as Record<string, unknown>), library: { ...tags, usages } };
    // Reuse extends the TTL of a working (prefetched) clip by another 7 days.
    const data: Prisma.MediaAssetVersionUpdateInput = { provenance: provenance as Prisma.InputJsonValue, ...(row.retentionClass === "working" ? { expiresAt: computeExpiresAt("working", now) } : {}) };
    await this.prisma.mediaAssetVersion.update({ where: { id: row.id }, data });
  }

  /**
   * Writes the library tags onto an imported clip (best effort, never throws). `ttl: "working"` (prefetch) also makes the clip a
   * working asset with the 7-day TTL; clips imported by a normal job keep their retention (they are used by a real video).
   */
  async tagAsset(assetId: string, input: Parameters<typeof buildLibraryTags>[0], options: { ttl?: "working" } = {}): Promise<boolean> {
    try {
      const row = await this.prisma.mediaAssetVersion.findFirst({ where: { id: assetId, deletedAt: null } });
      if (!row || row.kind !== "video") return false;
      const existing = readLibraryTags(row.provenance);
      if (existing) return true; // already tagged: keep the original tags/usages
      const base = (row.provenance && typeof row.provenance === "object" ? row.provenance : {}) as Record<string, unknown>;
      const apify = (base.apify && typeof base.apify === "object" ? base.apify : {}) as Record<string, unknown>;
      const attribution = (base.attribution && typeof base.attribution === "object" ? base.attribution : {}) as Record<string, unknown>;
      const caption = input.caption ?? (typeof apify.caption === "string" ? apify.caption : typeof apify.text === "string" ? apify.text : null);
      const tags = buildLibraryTags({
        ...input,
        caption,
        hashtags: input.hashtags ?? (Array.isArray(apify.hashtags) ? apify.hashtags.filter((h): h is string => typeof h === "string") : []),
        source: input.source ?? (typeof base.platform === "string" ? base.platform : row.origin),
        author: input.author ?? (typeof apify.author === "string" ? apify.author : typeof attribution.name === "string" ? attribution.name : null),
        ...(typeof base.query === "string" && !(input.en?.length || input.ja?.length) ? { en: [base.query] } : {}),
      });
      const data: Prisma.MediaAssetVersionUpdateInput = { provenance: { ...base, library: tags } as unknown as Prisma.InputJsonValue };
      if (options.ttl === "working") {
        data.retentionClass = "working";
        data.expiresAt = computeExpiresAt("working");
      }
      await this.prisma.mediaAssetVersion.update({ where: { id: assetId }, data });
      return true;
    } catch (error) {
      this.logger.warn(`library tag failed for ${assetId}: ${String(error)}`);
      return false;
    }
  }

  /** Library clips added by the prefetch since `since` (UTC day start): drives the per-day clip and cost caps (restart-safe, from the DB). */
  async prefetchedSince(projectIds: readonly string[], since: Date): Promise<{ clips: number; usd: number }> {
    const rows = await this.prisma.mediaAssetVersion.findMany({ where: { projectId: { in: [...projectIds] }, createdAt: { gte: since }, deletedAt: null }, select: { provenance: true } });
    let clips = 0;
    let usd = 0;
    for (const row of rows) {
      const tags = readLibraryTags(row.provenance);
      if (tags?.via !== "prefetch") continue;
      clips += 1;
      usd += tags.costUsd ?? 0;
    }
    return { clips, usd };
  }

  /**
   * 7-day TTL sweep: library clips of `working` class whose `expiresAt` passed are soft-deleted and their local file removed. `project`
   * class clips (used by a real video) are never touched here (same exemption as `isRetentionExempt`).
   */
  async sweepExpired(now: Date = new Date()): Promise<{ removed: number }> {
    const rows = await this.prisma.mediaAssetVersion.findMany({ where: { retentionClass: "working", deletedAt: null, expiresAt: { lte: now }, kind: "video", parentMediaAssetVersionId: null }, take: 500 });
    let removed = 0;
    for (const row of rows) {
      if (!readLibraryTags(row.provenance)) continue;
      try {
        await this.prisma.mediaAssetVersion.update({ where: { id: row.id }, data: { deletedAt: now } });
        await rm(join(mediaRoot(), row.relativePath), { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        this.logger.warn(`library sweep failed for ${row.id}: ${String(error)}`);
      }
    }
    return { removed };
  }
}
