import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PrismaService } from "./prisma.service.js";

@Injectable()
export class AuthRateLimiter {
  private lastCleanupAt = 0;
  private readonly localWindows = new Map<string, { count: number; resetAt: number }>();
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private consumeLocal(key: string, limit: number, durationMs: number, now: number) {
    for (const [expiredKey, window] of this.localWindows) if (window.resetAt <= now) this.localWindows.delete(expiredKey);
    const current = this.localWindows.get(key);
    if (current && current.count >= limit) return current.resetAt - now;
    this.localWindows.set(key, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? now + durationMs });
    return null;
  }

  /** Uses PostgreSQL atomic writes so limits are shared across API replicas and survive restarts. */
  async consume(scope: "login" | "register", ip: string, identifier: string, now = Date.now()) {
    const identityHash = createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex");
    const key = createHash("sha256").update(`${scope}\0${ip}\0${identityHash}`).digest("hex");
    const limit = scope === "login" ? 10 : 5;
    const durationMs = 15 * 60 * 1000;
    const resetAt = new Date(now + durationMs);

    const buckets = (this.prisma as unknown as { authRateLimitBucket?: {
      updateMany(args: unknown): Promise<unknown>;
      upsert(args: unknown): Promise<unknown>;
      findUnique(args: unknown): Promise<{ count: number; resetAt: Date } | null>;
      deleteMany(args: unknown): Promise<unknown>;
    } }).authRateLimitBucket;
    if (!buckets) {
      if (process.env.NODE_ENV !== "production") return this.consumeLocal(key, limit, durationMs, now);
      throw new Error("Auth rate-limit migration/client unavailable");
    }
    try {
      await buckets.updateMany({
        where: { key, resetAt: { lte: new Date(now) } },
        data: { count: 0, resetAt },
      });
      await buckets.upsert({
        where: { key },
        create: { key, count: 1, resetAt },
        update: { count: { increment: 1 } },
      });
      const bucket = await buckets.findUnique({ where: { key } });
      if (!bucket) throw new Error("Rate-limit bucket disappeared");
      // Opportunistic bounded cleanup; buckets contain only one-way hashes, never raw identifiers.
      if (now - this.lastCleanupAt > 10 * 60 * 1000) {
        this.lastCleanupAt = now;
        await buckets.deleteMany({ where: { resetAt: { lt: new Date(now - durationMs) } } });
      }
      return bucket.count <= limit ? null : Math.max(0, bucket.resetAt.getTime() - now);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (process.env.NODE_ENV !== "production" && ["P2021", "P2022"].includes(code)) return this.consumeLocal(key, limit, durationMs, now);
      throw error;
    }
  }
}
