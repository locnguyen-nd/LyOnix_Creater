import { beforeEach, describe, expect, it } from "vitest";
import { ProviderAccountsService } from "./provider-accounts.service.js";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1", name: "OpenAI primary", provider: "openai", role: "content", scope: "personal",
  ownerUserId: "user-1", status: "verified", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini"],
  encryptedSecret: "encrypted", isFake: false, version: 3, configVersion: 1, deletedAt: null,
  ...overrides,
});

describe("ProviderAccountsService lifecycle", () => {
  let store: any;
  let prisma: any;
  let service: ProviderAccountsService;

  beforeEach(() => {
    store = row();
    prisma = {
      providerAccount: {
        findFirst: async ({ where }: any) => where.id === store.id && store.deletedAt === null ? store : null,
        findUnique: async () => store,
        updateMany: async ({ where, data }: any) => {
          if (where.version !== store.version || store.deletedAt !== null) return { count: 0 };
          const { version, ...changes } = data;
          Object.assign(store, changes);
          if (version?.increment) store.version += version.increment;
          return { count: 1 };
        },
      },
    };
    service = new ProviderAccountsService(prisma);
  });

  it("updates an owned account only when If-Match version is current", async () => {
    const updated = await service.update("account-1", "user-1", "staff", 3, { name: "OpenAI fallback", model: "gpt-4o-mini" });
    expect(updated).toMatchObject({ name: "OpenAI fallback", version: 4 });
    expect(await service.update("account-1", "user-1", "staff", 3, { name: "stale" })).toBe("conflict");
  });

  it("does not let staff alter a shared organization account", async () => {
    store = row({ scope: "organization", ownerUserId: null });
    expect(await service.update("account-1", "user-1", "staff", 3, { name: "nope" })).toBe("forbidden");
  });

  it("soft-deletes an account so a pinned historical config is retained", async () => {
    expect(await service.remove("account-1", "user-1", "staff", 3)).toBe(true);
    expect(store.deletedAt).toBeInstanceOf(Date);
    expect(store.version).toBe(4);
  });
});
