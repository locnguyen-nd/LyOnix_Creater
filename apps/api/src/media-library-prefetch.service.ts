/**
 * VE2E-135 (CR-MEDIA-SLA 3.5): background prefetch of the media library by the channel's configured topics/subjects.
 *
 * OFF by default (it spends Apify money): set `MEDIA_LIBRARY_PREFETCH=1`. Runs only inside the off-peak hours
 * (`MEDIA_LIBRARY_PREFETCH_HOURS_UTC`, default `17-21` = 02:00-06:00 JST), at most `MEDIA_LIBRARY_PREFETCH_MAX_CLIPS_PER_DAY` clips (default 20)
 * and `MEDIA_LIBRARY_PREFETCH_MAX_USD_PER_DAY` Apify cost (default 2) per UTC day, `MEDIA_LIBRARY_PREFETCH_CLIPS_PER_TOPIC` (default 2) per topic
 * per run. Day totals come from the tagged clips in the DB (restart-safe). It uses the existing `ApifyService.autoImportForSegment`
 * (the shared Apify limiter is applied inside it), downloads nothing itself and never runs FFmpeg.
 *
 * Targets (no schema for per-channel topic config exists yet) = env `MEDIA_LIBRARY_PREFETCH_TARGETS`, JSON:
 *   [{"projectId":"<uuid>","userId":"<uuid>","role":"admin","topics":[{"ja":"...","en":"...","subject":"...","aliases":["..."]}]}]
 * Also schedules an hourly TTL sweep of expired working library clips (cheap, DB only; `MEDIA_LIBRARY_SWEEP=0` disables).
 */
import { Inject, Injectable, Logger, OnModuleInit, Optional } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { deriveSceneBrief, readLibraryTags } from "@lyonix/domain";
import { isValidJaSearchKeyword } from "@lyonix/providers";
import { ApifyJobContext, ApifyService } from "./apify.service.js";
import { MediaLibraryService } from "./media-library.service.js";
import { apifyAutoPlatformsFromEnv } from "./media-plan.service.js";
import { PrismaService } from "./prisma.service.js";

export type PrefetchTopic = { ja?: string; en?: string; subject?: string; aliases?: string[] };
export type PrefetchTarget = { projectId: string; userId: string; role?: "admin" | "staff"; topics: PrefetchTopic[] };
export type PrefetchSummary = { ran: boolean; reason?: string; imported: number; usd: number; skipped: number };

export const libraryPrefetchEnabled = (env: Record<string, string | undefined> = process.env): boolean => env.MEDIA_LIBRARY_PREFETCH === "1";

const num = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** `17-21` (UTC hours, inclusive start, exclusive end; may wrap midnight, e.g. `22-3`). */
export function inOffPeakHours(now: Date, spec: string | undefined = process.env.MEDIA_LIBRARY_PREFETCH_HOURS_UTC): boolean {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec((spec ?? "17-21").trim());
  const [start, end] = match ? [Number(match[1]) % 24, Number(match[2]) % 24] : [17, 21];
  const hour = now.getUTCHours();
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function parsePrefetchTargets(raw: string | undefined): PrefetchTarget[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.flatMap((item) => {
      const t = item as Partial<PrefetchTarget> | null;
      if (!t || typeof t.projectId !== "string" || typeof t.userId !== "string" || !Array.isArray(t.topics)) return [];
      const topics = t.topics.filter((topic): topic is PrefetchTopic => Boolean(topic && typeof topic === "object" && (topic.ja || topic.en || topic.subject)));
      return topics.length > 0 ? [{ projectId: t.projectId, userId: t.userId, role: t.role === "staff" ? "staff" : "admin", topics }] : [];
    });
  } catch {
    return [];
  }
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

@Injectable()
export class MediaLibraryPrefetchService implements OnModuleInit {
  private readonly logger = new Logger(MediaLibraryPrefetchService.name);
  private running = false;

  constructor(
    @Inject(MediaLibraryService) private readonly library: MediaLibraryService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(ApifyService) private readonly apify?: ApifyService,
    @Optional() @Inject(SchedulerRegistry) private readonly registry?: SchedulerRegistry,
  ) {}

  onModuleInit() {
    if (!this.registry || process.env.NODE_ENV === "test") return;
    if (process.env.MEDIA_LIBRARY_SWEEP !== "0") this.addTimer("media-library-sweep", () => void this.library.sweepExpired().catch(() => undefined), 60 * 60_000);
    if (libraryPrefetchEnabled()) {
      this.addTimer("media-library-prefetch", () => void this.runOnce().catch((error) => this.logger.warn(`prefetch tick failed: ${String(error)}`)), Math.max(5, num(process.env.MEDIA_LIBRARY_PREFETCH_INTERVAL_MINUTES, 30)) * 60_000);
      this.logger.log("Media library prefetch ENABLED (MEDIA_LIBRARY_PREFETCH=1)");
    }
  }

  private addTimer(name: string, fn: () => void, ms: number) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    try {
      this.registry!.deleteInterval(name);
    } catch {
      /* first boot */
    }
    this.registry!.addInterval(name, handle);
  }

  async runOnce(now: Date = new Date()): Promise<PrefetchSummary> {
    const none = (reason: string): PrefetchSummary => ({ ran: false, reason, imported: 0, usd: 0, skipped: 0 });
    if (!libraryPrefetchEnabled()) return none("disabled");
    if (!this.apify) return none("no_apify");
    if (!inOffPeakHours(now)) return none("peak_hours");
    if (this.running) return none("already_running");
    const targets = parsePrefetchTargets(process.env.MEDIA_LIBRARY_PREFETCH_TARGETS);
    if (targets.length === 0) return none("no_targets");
    this.running = true;
    try {
      const maxClips = num(process.env.MEDIA_LIBRARY_PREFETCH_MAX_CLIPS_PER_DAY, 20);
      const maxUsd = num(process.env.MEDIA_LIBRARY_PREFETCH_MAX_USD_PER_DAY, 2);
      const perTopic = Math.max(1, Math.floor(num(process.env.MEDIA_LIBRARY_PREFETCH_CLIPS_PER_TOPIC, 2)));
      const day = await this.library.prefetchedSince([...new Set(targets.map((t) => t.projectId))], startOfUtcDay(now));
      let clips = day.clips;
      let usd = day.usd;
      const summary: PrefetchSummary = { ran: true, imported: 0, usd: 0, skipped: 0 };
      for (const target of targets) {
        const account = await this.apify.findAccountForUser(target.userId, target.role ?? "admin").catch(() => null);
        if (!account) {
          summary.skipped += target.topics.length;
          continue;
        }
        const known = await this.knownExternalIds(target.projectId);
        for (const topic of target.topics) {
          for (let i = 0; i < perTopic; i += 1) {
            if (clips >= maxClips || usd >= maxUsd) return { ...summary, reason: clips >= maxClips ? "clip_cap" : "cost_cap" };
            const got = await this.prefetchOne(target, account, topic, known);
            usd += got.usd;
            summary.usd += got.usd;
            if (!got.ok) {
              summary.skipped += 1;
              break; // nothing usable for this topic now; do not burn budget retrying it in the same run
            }
            clips += 1;
            summary.imported += 1;
          }
        }
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async knownExternalIds(projectId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const rows = await this.prisma.mediaAssetVersion.findMany({ where: { projectId, deletedAt: null, kind: "video" }, select: { provenance: true }, orderBy: { createdAt: "desc" }, take: 1000 });
      for (const row of rows) {
        const id = readLibraryTags(row.provenance)?.externalId;
        if (id) ids.add(id.startsWith("apify:") ? id.split(":").slice(2).join(":") : id);
      }
    } catch {
      /* best effort: an unknown history only risks one extra duplicate check inside Apify's own library shortcut */
    }
    return ids;
  }

  private async prefetchOne(target: PrefetchTarget, account: { id: string; encryptedSecret: string }, topic: PrefetchTopic, known: Set<string>): Promise<{ ok: boolean; usd: number }> {
    const ja = topic.ja && isValidJaSearchKeyword(topic.ja) ? topic.ja : null;
    const keyword = ja ?? topic.en ?? topic.subject ?? "";
    if (!keyword) return { ok: false, usd: 0 };
    const job = new ApifyJobContext();
    job.overlayPolicy = "swap";
    const platform = apifyAutoPlatformsFromEnv()[0] ?? "tiktok";
    const brief = deriveSceneBrief({ language: ja ? "ja" : "en", scenes: [{ sceneId: "library-prefetch", narration: keyword, screenText: "", visualQuery: topic.en ?? keyword, durationHintMs: 8000 }] }, 0);
    try {
      const attempt = await this.apify!.autoImportForSegment(target.projectId, target.userId, target.role ?? "admin", account, {
        platform,
        mediaType: "video",
        keyword,
        brief: { ...brief, phrases: [keyword, ...brief.phrases.filter((phrase) => phrase !== keyword)].slice(0, 3) },
        sceneId: "library-prefetch",
        usedExternalIds: known,
        scriptLanguage: ja ? "ja" : "",
        segmentDurationSeconds: 6,
        keepOverlayFlagged: false,
        ...(ja ? {} : { lang: "en" as const }),
        ...(topic.subject || topic.aliases?.length ? { subjectAliases: [topic.subject, ...(topic.aliases ?? [])].filter((v): v is string => Boolean(v)) } : {}),
        job,
      });
      const usd = job.usage.usd ?? 0;
      if (!attempt.ok) return { ok: false, usd };
      const author = attempt.data.provenance?.author ?? null;
      await this.library.tagAsset(
        attempt.data.asset.id,
        { ja: topic.ja ? [topic.ja] : [], en: topic.en ? [topic.en] : [], subject: topic.subject ?? null, aliases: topic.aliases ?? [], source: platform, author, externalId: attempt.data.ledgerId, via: "prefetch", costUsd: usd },
        { ttl: "working" },
      );
      known.add(attempt.data.externalId);
      return { ok: true, usd };
    } catch (error) {
      this.logger.warn(`prefetch failed for "${keyword}": ${String(error)}`);
      return { ok: false, usd: job.usage.usd ?? 0 };
    }
  }
}
