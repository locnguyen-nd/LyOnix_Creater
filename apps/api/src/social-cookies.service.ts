import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import type { SocialCookiePlatform } from "@lyonix/domain";
import { MEDIA_FETCH_COOKIES_DIR, type MediaJobErrorCode } from "@lyonix/media-jobs";
import { mediaRoot } from "./handoff-workspace.js";
import { PrismaService } from "./prisma.service.js";
import { SOCIAL_COOKIES_PROVIDER } from "./provider-accounts.service.js";
import { decryptSecret } from "./secret-crypto.js";

export type CookieAccount = { id: string; name: string; platform: SocialCookiePlatform; encryptedSecret: string };
export type MaterializedCookies = { accountId: string; relativePath: string; dispose: () => Promise<void> };

/** A cookies file handed to the worker is deleted right after the job; anything older than this is a leftover of a crash. */
const STALE_COOKIE_FILE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;

const cooldownMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const value = Number(env.MEDIA_FETCH_COOKIE_COOLDOWN_MS);
  return Number.isFinite(value) && value >= 60_000 ? value : 30 * 60_000;
};

/**
 * VE2E-145 (CR-MEDIA-OSS-FETCH §3.3): the pool of `social_cookies` provider accounts used by yt-dlp / gallery-dl.
 * - `candidates` = verified, switched-on, not cooling down, visible to the user; least recently used first (rotation).
 * - `materialize` decrypts one into `MEDIA_ROOT/_private/cookies/<uuid>.txt` (0600) for ONE worker job; the caller always disposes it.
 *   Cookies never travel in a RabbitMQ message, a log line or an API response.
 * - `reportOutcome` closes the loop: COOKIES_INVALID -> `failed` (the admin sees it on the Providers page and re-exports), bot-check /
 *   429 -> `cooldownUntil` (MEDIA_FETCH_COOKIE_COOLDOWN_MS, default 30 min), success -> nothing (no DB write on the hot path).
 */
@Injectable()
export class SocialCookiesService {
  private readonly lastUsed = new Map<string, number>();
  private lastSweep = 0;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async candidates(platform: SocialCookiePlatform, userId: string, role: "admin" | "staff", now = new Date()): Promise<CookieAccount[]> {
    const rows = await this.prisma.providerAccount.findMany({
      where: {
        provider: SOCIAL_COOKIES_PROVIDER,
        role: "visual",
        model: platform,
        deletedAt: null,
        enabled: true,
        status: "verified",
        ...(process.env.NODE_ENV === "test" ? {} : { isFake: false }),
        OR: [{ cooldownUntil: null }, { cooldownUntil: { lte: now } }],
        ...(role === "admin" ? {} : { AND: [{ OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: userId }] }] }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true, encryptedSecret: true },
    });
    return rows
      .map((row) => ({ id: row.id, name: row.name, platform, encryptedSecret: row.encryptedSecret }))
      .sort((a, b) => (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0));
  }

  async materialize(account: CookieAccount): Promise<MaterializedCookies> {
    const dir = join(mediaRoot(), MEDIA_FETCH_COOKIES_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    void this.sweepStale(dir);
    const name = `${randomUUID()}.txt`;
    const absolute = join(dir, name);
    await writeFile(absolute, decryptSecret(account.encryptedSecret), { mode: 0o600 });
    this.lastUsed.set(account.id, Date.now());
    return { accountId: account.id, relativePath: `${MEDIA_FETCH_COOKIES_DIR}/${name}`, dispose: () => rm(absolute, { force: true }).catch(() => undefined) };
  }

  async reportOutcome(accountId: string, code: MediaJobErrorCode | null, now = new Date()): Promise<"failed" | "cooldown" | null> {
    if (code === "FETCH_COOKIES_INVALID") {
      await this.prisma.providerAccount.updateMany({ where: { id: accountId, provider: SOCIAL_COOKIES_PROVIDER, deletedAt: null }, data: { status: "failed", version: { increment: 1 } } });
      return "failed";
    }
    if (code === "FETCH_BOT_CHECK" || code === "FETCH_RATE_LIMITED") {
      await this.prisma.providerAccount.updateMany({ where: { id: accountId, provider: SOCIAL_COOKIES_PROVIDER, deletedAt: null }, data: { cooldownUntil: new Date(now.getTime() + cooldownMs()) } });
      return "cooldown";
    }
    return null;
  }

  private async sweepStale(dir: string): Promise<void> {
    if (Date.now() - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = Date.now();
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_COOKIE_FILE_MS) await rm(path, { force: true }).catch(() => undefined);
    }
  }
}
