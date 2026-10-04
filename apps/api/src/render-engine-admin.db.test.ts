import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderEngineAdminService } from "./render-engine-admin.service.js";
import { LYONIX_SYSTEM_USER_EMAIL, RenderEngineStoreService } from "./render-engine-store.service.js";
import { PrismaService } from "./prisma.service.js";

/**
 * VE2E-118 against a REAL PostgreSQL: the admin numbers must come from RenderJob rows, not from fixtures the code can echo back.
 * Opt-in (CI has no database): LYONIX_TEST_DATABASE_URL=postgresql://... with all migrations applied (`prisma migrate deploy`).
 * Safe on a shared DB: rows are created with a far-future clock (the report is asked for that same instant, so existing rows fall outside
 * the window) and only the rows this test created are deleted.
 */
const url = process.env.LYONIX_TEST_DATABASE_URL?.trim();
const NOW = new Date("2031-03-15T12:00:00Z");
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)("RenderEngineAdminService on PostgreSQL (VE2E-118)", () => {
  let prisma: PrismaService;
  let admin: RenderEngineAdminService;
  const created = { jobs: [] as string[], snapshots: [] as string[], accounts: [] as string[], projects: [] as string[] };
  let lyonixSnapshotId = "";
  let providerSnapshotId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = url!;
    prisma = new PrismaService();
    admin = new RenderEngineAdminService(prisma);
    const store = new RenderEngineStoreService(prisma);
    const synced = await store.sync();
    lyonixSnapshotId = synced.snapshots[0]!.snapshotId;
    const systemUser = await prisma.user.findUniqueOrThrow({ where: { email: LYONIX_SYSTEM_USER_EMAIL } });

    const account = await prisma.providerAccount.create({ data: { name: "db-test-creatomate", provider: "creatomate", role: "render", scope: "organization", model: "", encryptedSecret: "x", status: "verified" } });
    created.accounts.push(account.id);
    const snapshot = await prisma.templateSnapshot.create({ data: { providerAccountId: account.id, externalTemplateId: "db-test-tpl", name: "db-test provider template", modifications: [], rawTemplate: {}, engine: "creatomate", createdByUserId: systemUser.id } });
    providerSnapshotId = snapshot.id;
    created.snapshots.push(snapshot.id);
    const project = await prisma.project.create({ data: { name: "db-test-project", createdByUserId: systemUser.id } });
    created.projects.push(project.id);

    const job = async (n: number, data: Record<string, unknown>) => {
      const row = await prisma.renderJob.create({
        data: {
          projectId: project.id,
          templateSnapshotId: data.engine === "lyonix" ? lyonixSnapshotId : snapshot.id,
          providerAccountId: data.engine === "lyonix" ? synced.accountId : account.id,
          requestFingerprint: `db-test-${Date.now()}-${n}-${Math.random()}`,
          webhookToken: `db-test-token-${Date.now()}-${n}-${Math.random()}`,
          modificationsPayload: {},
          createdByUserId: systemUser.id,
          ...data,
        } as never,
      });
      created.jobs.push(row.id);
    };
    const failedQc = (...codes: string[]) => ({ passed: false, checks: codes.map((code) => ({ code, ok: false })), measured: {} });
    await job(1, { engine: "lyonix", routeReason: "default", status: "completed", renderDurationMs: 30_000, costAmount: "0.0100", costCurrency: "USD", createdAt: at("2031-03-15T01:00:00Z") });
    await job(2, { engine: "lyonix", routeReason: "default", status: "completed", renderDurationMs: 90_000, costAmount: "0.0300", costCurrency: "USD", createdAt: at("2031-03-14T01:00:00Z") });
    await job(3, { engine: "lyonix", routeReason: "default", status: "failed", qcReport: failedQc("QC_LOUDNESS"), createdAt: at("2031-03-14T02:00:00Z") });
    await job(4, { engine: "creatomate", routeReason: "fallback_after_error", status: "completed", costAmount: "0.5200", costCurrency: "USD", createdAt: at("2031-03-15T02:00:00Z") });
    await job(5, { engine: "creatomate", routeReason: "template_requires_provider", status: "completed", costAmount: "0.3000", costCurrency: "USD", createdAt: at("2031-03-15T03:00:00Z") });
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.renderJob.deleteMany({ where: { id: { in: created.jobs } } });
    await prisma.templateSnapshot.deleteMany({ where: { id: { in: created.snapshots } } });
    await prisma.providerAccount.deleteMany({ where: { id: { in: created.accounts } } });
    await prisma.project.deleteMany({ where: { id: { in: created.projects } } });
    await prisma.$disconnect();
  });

  it("reports the numbers of the rows that are really in the database", async () => {
    const { metrics, templates } = await admin.overview(7, NOW);
    expect(metrics.totalJobs).toBe(5);
    expect(metrics.byEngine.lyonix).toEqual({ jobs: 3, completed: 2, failed: 1 });
    expect(metrics.byEngine.creatomate).toEqual({ jobs: 2, completed: 2, failed: 0 });
    expect(metrics.internal.qcFailuresByCode).toEqual({ QC_LOUDNESS: 1 });
    expect(metrics.internal.renderMs).toEqual({ samples: 2, p50: 30_000, p95: 90_000 });
    expect(metrics.fallbacks).toMatchObject({ total: 1, byReason: { fallback_after_error: 1 } });
    expect(metrics.costByDay).toEqual([
      { date: "2031-03-14", lyonix: 0.03, creatomate: 0, orshot: 0, total: 0.03 },
      { date: "2031-03-15", lyonix: 0.01, creatomate: 0.82, orshot: 0, total: 0.83 },
    ]);
    expect(metrics.budget.fallbackTodayUsd).toBe(0.52);
    expect(templates.find((t) => t.snapshotId === lyonixSnapshotId)?.fallbackCandidates.some((c) => c.snapshotId === providerSnapshotId)).toBe(true);
  });

  it("persists rollout + fallback and refuses a rollout without a fallback", async () => {
    const before = await prisma.templateSnapshot.findUniqueOrThrow({ where: { id: lyonixSnapshotId } });
    try {
      expect(await admin.updateTemplate(lyonixSnapshotId, { rolloutPercent: 20 }, "admin")).toMatchObject({ ok: false });
      expect(await admin.updateTemplate(lyonixSnapshotId, { rolloutPercent: 20, fallbackSnapshotIds: [providerSnapshotId] }, "admin")).toMatchObject({ ok: true });
      const after = await prisma.templateSnapshot.findUniqueOrThrow({ where: { id: lyonixSnapshotId } });
      expect(after.rolloutPercent).toBe(20);
      expect(after.fallbackSnapshotIds).toEqual([providerSnapshotId]);
    } finally {
      await prisma.templateSnapshot.update({ where: { id: lyonixSnapshotId }, data: { rolloutPercent: before.rolloutPercent, fallbackSnapshotIds: before.fallbackSnapshotIds as never } });
    }
  });
});
