/**
 * Capacity (DEC-2026-10-02-CAPACITY-250): Prisma's default pool is `num_cpus * 2 + 1` connections per process, which 50 concurrent
 * Auto runs (each doing step bookkeeping + provider-limiter waits) can exhaust. `DATABASE_POOL_SIZE` sets `connection_limit` on the
 * connection URL without editing secrets in `.env`. An explicit `connection_limit` already present in `DATABASE_URL` always wins.
 */
export const MAX_DATABASE_POOL_SIZE = 200;

export type DatabasePoolResolution = { url: string | null; poolSize: number | null; warning: string | null };

export const resolveDatabasePool = (env: Record<string, string | undefined> = process.env): DatabasePoolResolution => {
  const raw = env.DATABASE_POOL_SIZE?.trim();
  if (!raw) return { url: null, poolSize: null, warning: null };
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1 || size > MAX_DATABASE_POOL_SIZE) {
    return { url: null, poolSize: null, warning: `DATABASE_POOL_SIZE="${raw}" is not an integer in [1, ${MAX_DATABASE_POOL_SIZE}]; using the Prisma default` };
  }
  const base = env.DATABASE_URL?.trim();
  if (!base) return { url: null, poolSize: null, warning: "DATABASE_POOL_SIZE ignored: DATABASE_URL is not set" };
  try {
    const url = new URL(base);
    if (url.searchParams.has("connection_limit")) return { url: null, poolSize: null, warning: null };
    url.searchParams.set("connection_limit", String(size));
    return { url: url.toString(), poolSize: size, warning: null };
  } catch {
    return { url: null, poolSize: null, warning: "DATABASE_POOL_SIZE ignored: DATABASE_URL is not a valid URL" };
  }
};
