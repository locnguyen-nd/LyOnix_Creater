import { describe, expect, it, vi } from "vitest";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1, RELEASED_RECIPES } from "@lyonix/render-recipes";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { LYONIX_ACCOUNT_NAME, LYONIX_PROVIDER, LYONIX_SYSTEM_USER_EMAIL, RenderEngineStoreService, recipeExternalId } from "./render-engine-store.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";

/** Minimal in-memory Prisma double covering exactly what the store touches. */
const fakePrisma = () => {
  const users: any[] = [];
  const accounts: any[] = [];
  const snapshots: any[] = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;
  const matches = (row: any, where: any): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && "equals" in (value as any)) return String(row[key]).toLowerCase() === String((value as any).equals).toLowerCase();
      return row[key] === value;
    });
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => users.find((u) => u.email === where.email) ?? null,
      create: async ({ data }: any) => {
        const row = { id: id("user"), ...data };
        users.push(row);
        return row;
      },
    },
    providerAccount: {
      findFirst: async ({ where }: any) => accounts.find((a) => matches(a, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: id("acct"), deletedAt: null, ...data };
        accounts.push(row);
        return row;
      },
    },
    templateSnapshot: {
      findFirst: async ({ where }: any) => snapshots.find((s) => matches(s, where)) ?? null,
      findMany: async ({ where, take }: any) => snapshots.filter((s) => matches(s, where)).sort((a, b) => +b.capturedAt - +a.capturedAt).slice(0, take ?? 99),
      create: async ({ data }: any) => {
        const row = { id: id("snap"), capturedAt: new Date(), ...data };
        snapshots.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(snapshots.find((s) => s.id === where.id)!, data),
    },
  };
  return { prisma, users, accounts, snapshots };
};

describe("RenderEngineStoreService (VE2E-111)", () => {
  it("creates a disabled system user, the secret-less system account and one engine=lyonix snapshot per released recipe, at rollout 0", async () => {
    const { prisma, users, accounts, snapshots } = fakePrisma();
    const result = await new RenderEngineStoreService(prisma).sync();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: LYONIX_SYSTEM_USER_EMAIL, disabled: true, role: "admin" });
    expect(users[0].passwordHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/); // a real, unguessable hash - sign-in is also blocked by `disabled`
    expect(accounts).toEqual([expect.objectContaining({ name: LYONIX_ACCOUNT_NAME, provider: LYONIX_PROVIDER, role: "render", scope: "organization", status: "verified", encryptedSecret: "", isFake: false, ownerUserId: null })]);
    expect(snapshots).toHaveLength(RELEASED_RECIPES.length);
    expect(snapshots[0]).toMatchObject({
      engine: "lyonix",
      rolloutPercent: 0,
      externalTemplateId: recipeExternalId(NEWS_RECAP_BROADCAST_TELOP_JP_V1),
      name: NEWS_RECAP_BROADCAST_TELOP_JP_V1.name,
      rawTemplate: NEWS_RECAP_BROADCAST_TELOP_JP_V1,
      providerAccountId: accounts[0].id,
      createdByUserId: users[0].id,
    });
    expect(snapshots[0].modifications.map((m: any) => m.key)).toEqual(["headline", "badge", "accent"]);
    expect(result.snapshots[0]).toMatchObject({ created: true, snapshotId: snapshots[0].id });
  });

  it("is idempotent and never resets an admin's rollout or explicit fallback list", async () => {
    const { prisma, users, accounts, snapshots } = fakePrisma();
    const store = new RenderEngineStoreService(prisma);
    await store.sync();
    snapshots[0].rolloutPercent = 25;
    snapshots[0].fallbackSnapshotIds = ["admin-choice"];
    prisma.templateSnapshot.create({ data: { engine: "creatomate", name: "News-Recap-Broadcast-Telop-JP", capturedAt: new Date(), id: "cm-1" } }).catch(() => undefined);
    const again = await store.sync();
    expect(users).toHaveLength(1);
    expect(accounts).toHaveLength(1);
    expect(snapshots.filter((s) => s.engine === "lyonix")).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ rolloutPercent: 25, fallbackSnapshotIds: ["admin-choice"] });
    expect(again.snapshots[0]).toMatchObject({ created: false, fallbackSnapshotIds: ["admin-choice"] });
  });

  it("links the newest pinned Creatomate snapshot named like the recipe as the fallback, and fills it later when it appears", async () => {
    const { prisma, snapshots } = fakePrisma();
    await prisma.templateSnapshot.create({ data: { engine: "creatomate", name: "news-recap-broadcast-telop-jp", id: undefined } });
    const older = snapshots[0];
    older.capturedAt = new Date("2026-01-01");
    older.id = "cm-old";
    snapshots.push({ id: "cm-new", engine: "creatomate", name: "NEWS-RECAP-BROADCAST-TELOP-JP", capturedAt: new Date("2026-09-01") });
    snapshots.push({ id: "cm-other", engine: "creatomate", name: "top-5-countdown-japan-vibrant", capturedAt: new Date("2026-10-01") });
    const result = await new RenderEngineStoreService(prisma).sync();
    expect(result.snapshots[0]!.fallbackSnapshotIds).toEqual(["cm-new"]);
    const internal = snapshots.find((s) => s.engine === "lyonix")!;
    expect(internal.fallbackSnapshotIds).toEqual(["cm-new"]);

    // later: an empty list is filled once an equivalent is pinned
    const { prisma: p2, snapshots: s2 } = fakePrisma();
    const store = new RenderEngineStoreService(p2);
    await store.sync();
    expect(s2.find((s) => s.engine === "lyonix")!.fallbackSnapshotIds).toEqual([]);
    s2.push({ id: "cm-late", engine: "creatomate", name: "news-recap-broadcast-telop-jp", capturedAt: new Date() });
    await store.sync();
    expect(s2.find((s) => s.engine === "lyonix")!.fallbackSnapshotIds).toEqual(["cm-late"]);
  });

  it("coalesces concurrent syncs and takes the advisory lock inside one transaction when the client supports it", async () => {
    const { prisma, snapshots } = fakePrisma();
    const executeRaw = vi.fn(async () => 1);
    prisma.$transaction = vi.fn(async (fn: any) => fn({ ...prisma, $executeRaw: executeRaw }));
    const store = new RenderEngineStoreService(prisma);
    const [a, b] = await Promise.all([store.sync(), store.sync()]);
    expect(a).toBe(b);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(RELEASED_RECIPES.length);
  });

  it("never blocks API start: a failing sync (e.g. database not migrated) is only logged", async () => {
    const { prisma } = fakePrisma();
    prisma.user.findUnique = async () => {
      throw new Error("relation does not exist");
    };
    await expect(new RenderEngineStoreService(prisma).onModuleInit()).resolves.toBeUndefined();
  });

  it("systemAccount() returns the existing account, or creates it on demand", async () => {
    const { prisma, accounts } = fakePrisma();
    const store = new RenderEngineStoreService(prisma);
    const created = await store.systemAccount();
    expect(created.id).toBe(accounts[0].id);
    expect(await store.systemAccount()).toMatchObject({ id: accounts[0].id });
    expect(accounts).toHaveLength(1);
  });
});

describe("internal templates behind the existing template endpoints", () => {
  const internalAccount = { provider: LYONIX_PROVIDER };
  const setup = () => {
    const { prisma, snapshots } = fakePrisma();
    const providerAccount = { findFirst: vi.fn(async ({ where }: any) => (where.id === "lyonix-acct" ? internalAccount : where.id === "cm-acct" ? { provider: "creatomate", role: "render", status: "verified", encryptedSecret: "x", isFake: false } : null)) };
    const store = new RenderEngineStoreService({ ...prisma, providerAccount: { ...prisma.providerAccount, findFirst: async (args: any) => (args.where.id ? providerAccount.findFirst(args) : prisma.providerAccount.findFirst(args)) } } as any);
    const service = new CreatomateTemplatesService({ ...prisma, providerAccount } as any, store);
    return { service, snapshots, prisma, providerAccount };
  };

  it("lists the released recipes for the system account without any secret or network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { service } = setup();
    const outcome = await service.listTemplates("lyonix-acct");
    expect(outcome).toMatchObject({ ok: true });
    if (outcome.ok) expect(outcome.data).toEqual(RELEASED_RECIPES.map((r) => expect.objectContaining({ externalTemplateId: recipeExternalId(r), name: r.name, previewUrl: null })));
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("'snapshotting' an internal template returns the pinned snapshot (engine fields included), rejects unknown ids, never needs a secret", async () => {
    const { service, snapshots, prisma } = setup();
    snapshots.push({ id: "snap-int", providerAccountId: "lyonix-acct", externalTemplateId: recipeExternalId(NEWS_RECAP_BROADCAST_TELOP_JP_V1), name: "n", previewUrl: null, modifications: [{ key: "headline", kind: "text", label: "h", required: false }], rawTemplate: {}, capturedAt: new Date("2026-10-01"), engine: "lyonix", rolloutPercent: 0, fallbackSnapshotIds: ["cm-1"] });
    prisma.templateSnapshot.findFirst = async ({ where }: any) => snapshots.find((s) => s.providerAccountId === where.providerAccountId && s.externalTemplateId === where.externalTemplateId) ?? null;
    const ok = await service.snapshot("lyonix-acct", recipeExternalId(NEWS_RECAP_BROADCAST_TELOP_JP_V1), "user-1");
    expect(ok).toMatchObject({ ok: true, data: { id: "snap-int", engine: "lyonix", rolloutPercent: 0, fallbackSnapshotIds: ["cm-1"] } });
    expect(await service.snapshot("lyonix-acct", "recipe:nope@1", "user-1")).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("the system account is never user-managed", () => {
  it("refuses update / verify / remove of a lyonix account, even for an administrator", async () => {
    const store = { id: "lyonix-acct", provider: "lyonix", role: "render", scope: "organization", ownerUserId: null, version: 1, deletedAt: null, model: "n/a", availableModels: [], preferredModels: [], encryptedSecret: "" };
    const service = new ProviderAccountsService({ providerAccount: { findFirst: async () => store, update: vi.fn(), updateMany: vi.fn() } } as any);
    expect(await service.update("lyonix-acct", "admin-1", "admin", 1, { name: "x" })).toBe("forbidden");
    expect(await service.verify("lyonix-acct", "admin-1", "admin")).toBe("forbidden");
    expect(await service.remove("lyonix-acct", "admin-1", "admin", 1)).toBe("forbidden");
  });
});
