import { Prisma } from "@lyonix/db";

/**
 * Test-only in-memory stand-in for the Prisma calls Trend Radar makes (never imported by runtime code). It keeps the constraints that matter:
 * unique (provider, sourceId) / canonicalUrl on items, unique (userId, dedupeKey) on notifications (`createMany` + `skipDuplicates`), unique
 * (day, model, kind) on AI usage, and serialises `$transaction` callbacks the way the advisory lock does.
 */

type Row = Record<string, any>;
let seq = 0;
const id = (prefix: string) => `${prefix}-${(++seq).toString().padStart(4, "0")}`;

const matchValue = (value: unknown, cond: any): boolean => {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === "object" && !Array.isArray(cond)) {
    if ("in" in cond) return (cond.in as unknown[]).includes(value);
    if ("notIn" in cond) return !(cond.notIn as unknown[]).includes(value);
    if ("gte" in cond || "lt" in cond || "gt" in cond || "lte" in cond) {
      const v = value instanceof Date ? value.getTime() : (value as number);
      const c = (x: any) => (x instanceof Date ? x.getTime() : x);
      if (v === null || v === undefined) return false;
      return (cond.gte === undefined || v >= c(cond.gte)) && (cond.gt === undefined || v > c(cond.gt)) && (cond.lt === undefined || v < c(cond.lt)) && (cond.lte === undefined || v <= c(cond.lte));
    }
    if ("contains" in cond) return typeof value === "string" && (cond.mode === "insensitive" ? value.toLowerCase().includes(String(cond.contains).toLowerCase()) : value.includes(cond.contains));
    if ("startsWith" in cond) return typeof value === "string" && value.startsWith(cond.startsWith);
    if ("not" in cond) return cond.not === null ? value !== null && value !== undefined : value !== cond.not;
  }
  return value === cond;
};

export function fakeTrendPrisma() {
  const db = {
    users: [] as Row[],
    accounts: [] as Row[],
    config: [] as Row[],
    runs: [] as Row[],
    clusters: [] as Row[],
    items: [] as Row[],
    itemSnapshots: [] as Row[],
    clusterSnapshots: [] as Row[],
    assignments: [] as Row[],
    usage: [] as Row[],
    notifications: [] as Row[],
    jobs: [] as Row[],
    sources: [] as Row[],
    scripts: [] as Row[],
  };

  const relations: Record<string, (row: Row, spec: any) => unknown> = {
    items: (row, spec) => {
      let rows = db.items.filter((item) => item.clusterId === row.id);
      if (spec?.orderBy?.collectedAt) rows = [...rows].sort((a, b) => a.collectedAt - b.collectedAt);
      if (spec?.take) rows = rows.slice(0, spec.take);
      return rows.map((item) => project(item, spec, "item"));
    },
    // an item's metric snapshots, or a cluster's item-count snapshots
    snapshots: (row, spec) => {
      const rows = (row.provider !== undefined ? db.itemSnapshots.filter((s) => s.itemId === row.id) : db.clusterSnapshots.filter((s) => s.clusterId === row.id)).sort((a, b) => (spec?.orderBy?.measuredAt === "asc" ? a.measuredAt - b.measuredAt : b.measuredAt - a.measuredAt));
      return spec?.take ? rows.slice(0, spec.take) : rows;
    },
    assignments: (row, spec) => db.assignments.filter((a) => a.clusterId === row.id).map((a) => (spec?.include?.user ? { ...a, user: { displayName: db.users.find((u) => u.id === a.userId)?.displayName ?? "?" } } : a)),
    workflowRuns: () => [],
    sourceVersion: () => ({ workflowRuns: [] }),
  };

  function project(row: Row, spec: any, _kind?: string): Row {
    if (!spec || spec === true) return { ...row };
    const out: Row = spec.select ? {} : { ...row };
    if (spec.select) {
      for (const [key, value] of Object.entries(spec.select)) out[key] = key in relations && value ? relations[key]!(row, value) : row[key];
    }
    if (spec.include) for (const [key, value] of Object.entries(spec.include)) if (value) out[key] = relations[key]!(row, value);
    return out;
  }

  const where = (row: Row, cond: any): boolean => {
    if (!cond) return true;
    return Object.entries(cond).every(([key, value]) => {
      if (key === "OR") return (value as any[]).some((c) => where(row, c));
      if (key === "items") {
        const items = db.items.filter((item) => item.clusterId === row.id);
        return (value as any).some ? items.some((item) => where(item, (value as any).some)) : true;
      }
      if (key === "assignments") return db.assignments.filter((a) => a.clusterId === row.id).some((a) => where(a, (value as any).some));
      return matchValue(row[key], value);
    });
  };

  const sortRows = (rows: Row[], orderBy: any): Row[] => {
    const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((a, b) => {
      for (const order of orders) {
        const [key, dir] = Object.entries(order)[0] as [string, string];
        const av = a[key] instanceof Date ? a[key].getTime() : a[key];
        const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
        if (av === bv) continue;
        return (av < bv ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };

  const unique = (message: string) => new Prisma.PrismaClientKnownRequestError(message, { code: "P2002", clientVersion: "test" });

  const table = (rows: Row[], prefix: string, opts: { defaults?: () => Row; check?: (row: Row, rows: Row[]) => void } = {}) => ({
    findUnique: async (args: any) => {
      const found = rows.find((row) => where(row, args.where));
      return found ? project(found, args) : null;
    },
    findUniqueOrThrow: async (args: any) => {
      const found = rows.find((row) => where(row, args.where));
      if (!found) throw new Error("not found");
      return project(found, args);
    },
    findFirst: async (args: any = {}) => {
      const found = sortRows(rows.filter((row) => where(row, args.where)), args.orderBy)[0];
      return found ? project(found, args) : null;
    },
    findMany: async (args: any = {}) => {
      let found = sortRows(rows.filter((row) => where(row, args.where)), args.orderBy);
      if (args.skip) found = found.slice(args.skip);
      if (args.take) found = found.slice(0, args.take);
      return found.map((row) => project(row, args));
    },
    count: async (args: any = {}) => rows.filter((row) => where(row, args.where)).length,
    groupBy: async (args: any) => {
      const groups = new Map<string, number>();
      for (const row of rows.filter((r) => where(r, args.where))) groups.set(row[args.by[0]], (groups.get(row[args.by[0]]) ?? 0) + 1);
      return [...groups.entries()].map(([key, count]) => ({ [args.by[0]]: key, _count: count }));
    },
    create: async (args: any) => {
      const row = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...(opts.defaults?.() ?? {}), ...args.data };
      for (const [key, value] of Object.entries(row)) if (value === Prisma.JsonNull) row[key] = null;
      opts.check?.(row, rows);
      rows.push(row);
      return project(row, args);
    },
    createMany: async (args: any) => {
      let count = 0;
      for (const data of args.data) {
        const row = { id: id(prefix), createdAt: new Date(), ...(opts.defaults?.() ?? {}), ...data };
        try {
          opts.check?.(row, rows);
        } catch (error) {
          if (args.skipDuplicates) continue;
          throw error;
        }
        rows.push(row);
        count += 1;
      }
      return { count };
    },
    update: async (args: any) => {
      const row = rows.find((r) => where(r, args.where));
      if (!row) throw new Error(`${prefix} not found`);
      apply(row, args.data);
      return project(row, args);
    },
    updateMany: async (args: any) => {
      const found = rows.filter((r) => where(r, args.where));
      for (const row of found) apply(row, args.data);
      return { count: found.length };
    },
    upsert: async (args: any) => {
      const row = rows.find((r) => where(r, flattenCompound(args.where)));
      if (row) {
        apply(row, args.update);
        return { ...row };
      }
      const created = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...(opts.defaults?.() ?? {}), ...args.create };
      rows.push(created);
      return { ...created };
    },
    deleteMany: async (args: any) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1) if (where(rows[index]!, args.where)) rows.splice(index, 1);
      return { count: before - rows.length };
    },
  });

  function flattenCompound(cond: any): any {
    const out: any = {};
    for (const [key, value] of Object.entries(cond)) {
      if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && key.includes("_")) Object.assign(out, value);
      else out[key] = value;
    }
    return out;
  }

  function apply(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in (value as any)) row[key] = (row[key] ?? 0) + (value as any).increment;
      else row[key] = value === Prisma.JsonNull ? null : value;
    }
    row.updatedAt = new Date();
  }

  const configDefaults = () => ({ yahooEnabled: false, yahooCategories: ["japan", "sports", "entertainment", "trending"], tiktokEnabled: false, tiktokAccountId: null, keywords: [], hashtags: [], categories: [], windowHours: 48, scheduleEnabled: true, intervalMinutes: 45, thresholds: { hot: 80, rising: 60, review: 40 }, notifyMinScore: 60, tiktokMaxQueries: 4, tiktokResultsPerQuery: 15, tiktokMinViews: 0, analysisAccountId: null, autoAnalysisPerDay: 5, analysisPerDay: 15 });

  let txChain: Promise<unknown> = Promise.resolve();
  const prisma: any = {
    user: table(db.users, "user"),
    providerAccount: table(db.accounts, "acct"),
    trendRadarConfig: table(db.config, "cfg", { defaults: configDefaults }),
    trendRun: table(db.runs, "run", { defaults: () => ({ sources: [], fetchedCount: 0, newCount: 0, duplicateCount: 0, clusterCount: 0, notifiedCount: 0, analysedCount: 0, error: null, startedAt: null, finishedAt: null }) }),
    trendCluster: table(db.clusters, "cluster", { defaults: () => ({ status: "new", saved: false, score: 0, band: "low", scoreBreakdown: {}, itemCount: 0, analysis: null, analysisStatus: "none", analysisError: null, analysisModel: null, analyzedAt: null, notifiedBands: [], productionRefs: [], reviewedByUserId: null, reviewedAt: null }) }),
    trendItem: table(db.items, "item", {
      check: (row, rows) => {
        if (rows.some((r) => r.canonicalUrl === row.canonicalUrl) || rows.some((r) => r.provider === row.provider && r.sourceId === row.sourceId)) throw unique("TrendItem unique");
      },
    }),
    trendItemSnapshot: table(db.itemSnapshots, "isnap"),
    trendClusterSnapshot: table(db.clusterSnapshots, "csnap"),
    trendAssignment: table(db.assignments, "assign"),
    trendAiUsage: table(db.usage, "usage", { defaults: () => ({ calls: 0, failures: 0 }) }),
    notification: table(db.notifications, "notif", {
      defaults: () => ({ readAt: null, body: null, link: null, data: null }),
      check: (row, rows) => {
        if (rows.some((r) => r.userId === row.userId && r.dedupeKey === row.dedupeKey)) throw unique("Notification unique");
      },
    }),
    productionRequest: table(db.jobs, "job"),
    sourceVersion: table(db.sources, "src"),
    scriptDraftVersion: table(db.scripts, "script"),
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const next = txChain.then(() => fn(prisma));
      txChain = next.catch(() => undefined);
      return next;
    },
  };
  return { prisma, db };
}
