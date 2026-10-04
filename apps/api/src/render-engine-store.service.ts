import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@lyonix/db";
import { RELEASED_RECIPES, recipeToModificationSlots, type RenderRecipe } from "@lyonix/render-recipes";
import { hashPassword } from "./password.js";
import { PrismaService } from "./prisma.service.js";

/** Provider name of the internal FFmpeg engine's system account (no secret, never user-managed). */
export const LYONIX_PROVIDER = "lyonix";
export const LYONIX_SYSTEM_USER_EMAIL = "system@lyonix.internal";
export const LYONIX_ACCOUNT_NAME = "LyOnix (tự render)";

/** `TemplateSnapshot.externalTemplateId` of an internal recipe. Immutable per version, so a snapshot per `id@version` is pinned once. */
/** Arbitrary constant identifying this lock among the application's advisory locks. */
const ADVISORY_LOCK_KEY = 7_021_004_111;

export const recipeExternalId = (recipe: Pick<RenderRecipe, "id" | "version">): string => `recipe:${recipe.id}@${recipe.version}`;

export type RecipeSyncResult = { accountId: string; snapshots: Array<{ recipeId: string; version: number; snapshotId: string; created: boolean; fallbackSnapshotIds: string[] }> };

/**
 * VE2E-111: template store of the internal engine. At boot (and lazily when templates are listed) it makes sure that
 *  - a disabled system user exists (TemplateSnapshot.createdBy is a required FK; this user can never sign in),
 *  - the system render account `provider = "lyonix"` exists (no secret, organization scope, verified), so Studio/Auto pick the internal engine
 *    like any other account,
 *  - every released recipe is pinned as a `TemplateSnapshot` (`engine = "lyonix"`, `rawTemplate` = the recipe, `modifications` = its slots).
 * Re-running is idempotent and never resets an admin's `rolloutPercent` / `fallbackSnapshotIds` (a new snapshot starts at rolloutPercent 0).
 */
@Injectable()
export class RenderEngineStoreService implements OnModuleInit {
  private readonly logger = new Logger(RenderEngineStoreService.name);
  private syncing: Promise<RecipeSyncResult> | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Never blocks API start: a database that is not migrated yet (or down) must not take the whole API with it.
    try {
      await this.sync();
    } catch (error) {
      this.logger.warn(`internal render template sync skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Coalesces concurrent callers in this process onto one run, and serialises runs across API replicas with a transaction-scoped Postgres
   * advisory lock (the snapshot table has no unique key on (account, externalTemplateId) and migrations may only add columns, so without the
   * lock two replicas booting together could pin the same recipe twice).
   */
  sync(recipes: readonly RenderRecipe[] = RELEASED_RECIPES): Promise<RecipeSyncResult> {
    if (this.syncing) return this.syncing;
    const run = typeof this.prisma.$transaction === "function"
      ? this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
            return this.run(recipes, tx as unknown as PrismaService);
          },
          { timeout: 30_000 },
        )
      : this.run(recipes);
    this.syncing = run.finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async systemAccount(): Promise<{ id: string }> {
    const existing = await this.prisma.providerAccount.findFirst({ where: { provider: LYONIX_PROVIDER, role: "render", deletedAt: null }, select: { id: true } });
    if (existing) return existing;
    return { id: (await this.sync()).accountId };
  }

  private async systemUserId(db: PrismaService = this.prisma): Promise<string> {
    const found = await db.user.findUnique({ where: { email: LYONIX_SYSTEM_USER_EMAIL }, select: { id: true } });
    if (found) return found.id;
    const created = await db.user.create({
      // role "admin" only because there are exactly two roles; `disabled` + a random password make sign-in impossible.
      data: { email: LYONIX_SYSTEM_USER_EMAIL, displayName: "LyOnix system", passwordHash: hashPassword(randomBytes(32).toString("hex")), role: "admin", disabled: true, approved: true },
      select: { id: true },
    });
    return created.id;
  }

  private async ensureAccount(db: PrismaService = this.prisma): Promise<string> {
    const existing = await db.providerAccount.findFirst({ where: { provider: LYONIX_PROVIDER, role: "render", deletedAt: null }, select: { id: true } });
    if (existing) return existing.id;
    const created = await db.providerAccount.create({
      data: { name: LYONIX_ACCOUNT_NAME, provider: LYONIX_PROVIDER, role: "render", scope: "organization", ownerUserId: null, status: "verified", model: "n/a", encryptedSecret: "", isFake: false },
      select: { id: true },
    });
    return created.id;
  }

  /** The newest pinned Creatomate snapshot named like the recipe (`news-recap-broadcast-telop-jp`): its provider-side equivalent used for fallbacks. */
  private async findProviderEquivalents(recipe: RenderRecipe, db: PrismaService = this.prisma): Promise<string[]> {
    const rows = await db.templateSnapshot.findMany({
      where: { engine: "creatomate", name: { equals: recipe.id, mode: "insensitive" } },
      orderBy: { capturedAt: "desc" },
      take: 1,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  private async run(recipes: readonly RenderRecipe[], db: PrismaService = this.prisma): Promise<RecipeSyncResult> {
    const userId = await this.systemUserId(db);
    const accountId = await this.ensureAccount(db);
    const snapshots: RecipeSyncResult["snapshots"] = [];
    for (const recipe of recipes) {
      const externalTemplateId = recipeExternalId(recipe);
      const existing = await db.templateSnapshot.findFirst({ where: { providerAccountId: accountId, externalTemplateId }, select: { id: true, fallbackSnapshotIds: true } });
      const equivalents = await this.findProviderEquivalents(recipe, db);
      if (existing) {
        const current = Array.isArray(existing.fallbackSnapshotIds) ? (existing.fallbackSnapshotIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
        // only fills an empty list: an admin's explicit choice is never overwritten
        if (current.length === 0 && equivalents.length > 0) {
          await db.templateSnapshot.update({ where: { id: existing.id }, data: { fallbackSnapshotIds: equivalents as unknown as Prisma.InputJsonValue } });
          snapshots.push({ recipeId: recipe.id, version: recipe.version, snapshotId: existing.id, created: false, fallbackSnapshotIds: equivalents });
        } else {
          snapshots.push({ recipeId: recipe.id, version: recipe.version, snapshotId: existing.id, created: false, fallbackSnapshotIds: current });
        }
        continue;
      }
      const row = await db.templateSnapshot.create({
        data: {
          providerAccountId: accountId,
          externalTemplateId,
          name: recipe.name,
          previewUrl: null,
          modifications: recipeToModificationSlots(recipe) as unknown as Prisma.InputJsonValue,
          rawTemplate: recipe as unknown as Prisma.InputJsonValue,
          engine: LYONIX_PROVIDER,
          fallbackSnapshotIds: equivalents as unknown as Prisma.InputJsonValue,
          rolloutPercent: 0,
          createdByUserId: userId,
        },
        select: { id: true },
      });
      snapshots.push({ recipeId: recipe.id, version: recipe.version, snapshotId: row.id, created: true, fallbackSnapshotIds: equivalents });
    }
    return { accountId, snapshots };
  }
}
