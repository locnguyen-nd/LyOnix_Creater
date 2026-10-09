import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@lyonix/db";
import { countTemplateSceneSlots, listCreatomateTemplates } from "@lyonix/providers";
import { RELEASED_RECIPES } from "@lyonix/render-recipes";
import { MediaJobsGateway } from "./media-jobs.gateway.js";
import { recipeExternalId } from "./render-engine-store.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { auditCreatomate, auditLyonix, formatTemplateAudit, type SnapshotFacts, type TemplateAuditRow } from "./template-audit.js";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

/**
 * Read-only template catalog audit: `corepack pnpm --filter @lyonix/api report:templates [-- --json]`.
 * Calls Creatomate's template LIST only (free, no render); prints ids, names, counts and reasons - never secrets or media URLs.
 */
const asJson = process.argv.includes("--json");

const slotList = (value: unknown): SnapshotFacts["modifications"] =>
  Array.isArray(value)
    ? value.flatMap((slot) => (slot && typeof slot === "object" && typeof (slot as { key?: unknown }).key === "string" ? [{ key: (slot as { key: string }).key, kind: String((slot as { kind?: unknown }).kind ?? ""), required: (slot as { required?: unknown }).required === true }] : []))
    : [];

/** Creatomate fetches every scene file from PUBLIC_BASE_URL: is it reachable from outside right now? */
async function publicBaseReachable(): Promise<boolean> {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (!base || /localhost|127\.0\.0\.1/.test(base)) return false;
  try {
    const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch {
    return false;
  }
}

const main = async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set; nothing was queried");
  const prisma = new PrismaClient();
  const gateway = new MediaJobsGateway();
  try {
    const accounts = await prisma.providerAccount.findMany({ where: { role: "render", deletedAt: null }, select: { id: true, provider: true, status: true, isFake: true, encryptedSecret: true } });
    const snapshots = await prisma.templateSnapshot.findMany({ select: { id: true, externalTemplateId: true, name: true, engine: true, providerAccountId: true, rolloutPercent: true, fallbackSnapshotIds: true, modifications: true, rawTemplate: true, createdAt: true } });
    const facts = (row: (typeof snapshots)[number]): SnapshotFacts => ({
      id: row.id,
      externalTemplateId: row.externalTemplateId,
      name: row.name,
      engine: row.engine,
      providerAccountId: row.providerAccountId,
      rolloutPercent: row.rolloutPercent,
      fallbackSnapshotIds: Array.isArray(row.fallbackSnapshotIds) ? row.fallbackSnapshotIds.filter((id): id is string => typeof id === "string") : [],
      modifications: slotList(row.modifications),
      sceneSlots: row.engine === "creatomate" ? countTemplateSceneSlots(row.rawTemplate) : 0,
      createdAt: row.createdAt,
    });
    const rows: TemplateAuditRow[] = [];
    const reachable = await publicBaseReachable();
    const usableCreatomate = accounts.filter((account) => account.provider === "creatomate" && account.status === "verified" && !account.isFake);
    for (const account of accounts.filter((row) => row.provider === "creatomate")) {
      let live: Parameters<typeof auditCreatomate>[0]["live"];
      try {
        live = { ok: true, templates: await listCreatomateTemplates(decryptSecret(account.encryptedSecret)) };
      } catch (error) {
        live = { ok: false, code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "LIST_FAILED" };
      }
      rows.push(...auditCreatomate({ accountId: account.id, accountUsable: account.status === "verified", live, snapshots: snapshots.filter((row) => row.providerAccountId === account.id).map(facts), publicMediaReachable: reachable }));
    }
    const usableFallbackIds = new Set(snapshots.filter((row) => row.engine === "creatomate" && usableCreatomate.some((account) => account.id === row.providerAccountId)).map((row) => row.id));
    const queue = await gateway.renderQueueStatus();
    for (const account of accounts.filter((row) => row.provider === "lyonix")) {
      rows.push(...auditLyonix({
        accountId: account.id,
        recipes: RELEASED_RECIPES.map((recipe) => ({ externalTemplateId: recipeExternalId(recipe), name: recipe.name, captionsEnabled: recipe.captions.enabled, slots: recipe.slots.map((slot) => ({ key: slot.key, kind: slot.kind, required: slot.required })) })),
        snapshots: snapshots.filter((row) => row.providerAccountId === account.id).map(facts),
        renderConsumers: queue ? queue.consumers : null,
        usableFallbackIds,
      }));
    }
    const orshot = accounts.filter((row) => row.provider === "orshot");
    console.log(asJson ? JSON.stringify({ rows, orshotAccounts: orshot.length, publicMediaReachable: reachable, renderQueue: queue }, null, 2) : `${formatTemplateAudit(rows)}\nOrshot: ${orshot.length} tài khoản render${orshot.length ? "" : " (không có template Orshot nào hiển thị)"}\nPUBLIC_BASE_URL truy cập được từ internet: ${reachable ? "có" : "KHÔNG"}  ·  lyonix.render consumers: ${queue ? queue.consumers : "?"}`);
  } finally {
    await gateway.onModuleDestroy?.();
    await prisma.$disconnect();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "template audit failed");
  process.exitCode = 1;
});
