import { describe, expect, it } from "vitest";
import { AuthRateLimiter } from "./auth-rate-limit.js";

const sharedStore = () => {
  const buckets = new Map<string, { key: string; count: number; resetAt: Date }>();
  const prisma: any = {
    authRateLimitBucket: {
      updateMany: async ({ where, data }: any) => {
        const row = buckets.get(where.key);
        if (row && row.resetAt <= where.resetAt.lte) Object.assign(row, data);
        return { count: row && row.resetAt.getTime() === data.resetAt.getTime() ? 1 : 0 };
      },
      upsert: async ({ where, create, update }: any) => {
        const row = buckets.get(where.key);
        if (row) row.count += update.count.increment;
        else buckets.set(create.key, { ...create });
      },
      findUnique: async ({ where }: any) => buckets.get(where.key) ?? null,
      deleteMany: async ({ where }: any) => {
        for (const [key, row] of buckets) if (row.resetAt < where.resetAt.lt) buckets.delete(key);
        return { count: 0 };
      },
    },
  };
  return { buckets, prisma };
};

describe("AuthRateLimiter", () => {
  it("shares login limits across limiter instances and resets after the window", async () => {
    const { prisma, buckets } = sharedStore();
    const firstReplica = new AuthRateLimiter(prisma);
    const secondReplica = new AuthRateLimiter(prisma);
    for (let attempt = 0; attempt < 10; attempt += 1) expect(await firstReplica.consume("login", "127.0.0.1", " User@Example.com ", 1000)).toBeNull();
    expect(await secondReplica.consume("login", "127.0.0.1", "user@example.com", 1000)).toBe(900_000);
    expect(await secondReplica.consume("login", "127.0.0.2", "user@example.com", 1000)).toBeNull();
    expect(await firstReplica.consume("login", "127.0.0.1", "user@example.com", 901_000)).toBeNull();
    expect([...buckets.keys()].every((key) => !key.includes("user@example.com"))).toBe(true);
  });

  it("applies a separate, lower registration limit", async () => {
    const { prisma } = sharedStore();
    const limiter = new AuthRateLimiter(prisma);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await limiter.consume("register", "127.0.0.1", "new@example.com", 1000)).toBeNull();
    expect(await limiter.consume("register", "127.0.0.1", "new@example.com", 1000)).toBe(900_000);
    expect(await limiter.consume("login", "127.0.0.1", "new@example.com", 1000)).toBeNull();
  });
});
