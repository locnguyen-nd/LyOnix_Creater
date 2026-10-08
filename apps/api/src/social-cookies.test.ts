import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { decryptSecret, encryptSecret } from "./secret-crypto.js";
import { SocialCookiesService } from "./social-cookies.service.js";

// VE2E-145: cookies accounts (validation + filtering at create/update, offline verify) and the pool used by the fetch ladder.

const future = Math.floor(new Date("2099-01-01T00:00:00Z").getTime() / 1000);
const past = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
const line = (domain: string, expiry: number) => [domain, "TRUE", "/", "TRUE", String(expiry), "sessionid", "VALUE-123"].join("\t");
const exported = ["# Netscape HTTP Cookie File", line(".tiktok.com", future), line(".mybank.example", future)].join("\n");

let prevKey: string | undefined;
let prevRoot: string | undefined;
let root: string;
beforeEach(async () => {
  prevKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
  process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  root = await mkdtemp(join(tmpdir(), "lyonix-cookies-"));
  prevRoot = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = root;
});
afterEach(async () => {
  process.env.PERSISTENCE_ENCRYPTION_KEY = prevKey;
  if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
  await rm(root, { recursive: true, force: true });
});

describe("ProviderAccountsService social_cookies (VE2E-145)", () => {
  const base = { name: "TikTok phụ", provider: "social_cookies", role: "visual" as const, scope: "personal" as const, model: "tiktok" };

  it("stores only the platform's lines (encrypted) and verifies offline", async () => {
    let created: any;
    const prisma = {
      providerAccount: {
        create: vi.fn(async ({ data }: any) => (created = { id: "c1", status: "unverified", version: 1, isFake: false, ownerUserId: "u1", deletedAt: null, availableModels: [], ...data })),
        findFirst: vi.fn(async () => created),
        update: vi.fn(async ({ data }: any) => {
          Object.assign(created, data, { version: created.version + 1 });
          return created;
        }),
      },
    };
    const service = new ProviderAccountsService(prisma as any);
    const account = await service.create({ ...base, secret: exported }, "u1", "staff");
    expect(account).toMatchObject({ provider: "social_cookies", model: "tiktok", status: "unverified" });
    const stored = decryptSecret(created.encryptedSecret);
    expect(stored).toContain(".tiktok.com");
    expect(stored).not.toContain("mybank");
    expect(JSON.stringify(account)).not.toContain("VALUE-123");
    const verified = await service.verify("c1", "u1", "staff");
    expect(verified).toMatchObject({ status: "verified", secretExpiresAt: "2099-01-01T00:00:00.000Z" });
  });

  it("refuses an unknown platform, a non-Netscape paste, foreign-only or expired cookies", async () => {
    const service = new ProviderAccountsService({ providerAccount: { create: vi.fn() } } as any);
    expect(await service.create({ ...base, model: "facebook", secret: exported }, "u1", "staff")).toEqual({ invalidCookies: "bad_platform" });
    expect(await service.create({ ...base, secret: "sessionid=abc" }, "u1", "staff")).toEqual({ invalidCookies: "not_netscape" });
    expect(await service.create({ ...base, secret: line(".mybank.example", future) }, "u1", "staff")).toEqual({ invalidCookies: "no_platform_cookies" });
    expect(await service.create({ ...base, secret: line(".tiktok.com", past) }, "u1", "staff")).toEqual({ invalidCookies: "all_expired" });
  });
});

describe("SocialCookiesService pool (VE2E-145)", () => {
  const rows = [
    { id: "a", name: "A", encryptedSecret: "" },
    { id: "b", name: "B", encryptedSecret: "" },
  ];

  it("queries only usable accounts of the platform, rotates least recently used first", async () => {
    rows.forEach((r) => (r.encryptedSecret = encryptSecret(`# Netscape HTTP Cookie File\n${line(".tiktok.com", future)}\n`)));
    const findMany = vi.fn(async () => rows);
    const service = new SocialCookiesService({ providerAccount: { findMany } } as any);
    const first = await service.candidates("tiktok", "u1", "staff");
    expect(findMany.mock.calls[0]![0]).toMatchObject({ where: { provider: "social_cookies", model: "tiktok", status: "verified", enabled: true, deletedAt: null } });
    expect(first.map((c) => c.id)).toEqual(["a", "b"]);
    const handed = await service.materialize(first[0]!);
    await handed.dispose();
    expect((await service.candidates("tiktok", "u1", "staff")).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("materialize writes a 0600 file under _private/cookies and dispose removes it", async () => {
    const service = new SocialCookiesService({} as any);
    const handed = await service.materialize({ id: "a", name: "A", platform: "tiktok", encryptedSecret: encryptSecret("# Netscape HTTP Cookie File\nx\n") });
    expect(handed.relativePath).toMatch(/^_private\/cookies\/[0-9a-f-]{36}\.txt$/);
    const absolute = join(root, handed.relativePath);
    expect(await readFile(absolute, "utf8")).toContain("Netscape");
    if (process.platform !== "win32") expect((await stat(absolute)).mode & 0o777).toBe(0o600);
    await handed.dispose();
    expect(await readdir(join(root, "_private/cookies"))).toEqual([]);
  });

  it("reportOutcome: invalid -> failed, bot check / 429 -> cool-down, success -> no write", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const service = new SocialCookiesService({ providerAccount: { updateMany } } as any);
    const now = new Date("2026-10-08T00:00:00Z");
    expect(await service.reportOutcome("a", "FETCH_COOKIES_INVALID", now)).toBe("failed");
    expect(await service.reportOutcome("a", "FETCH_BOT_CHECK", now)).toBe("cooldown");
    expect(await service.reportOutcome("a", null, now)).toBeNull();
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect((updateMany.mock.calls[0] as any)[0].data).toMatchObject({ status: "failed" });
    expect((updateMany.mock.calls[1] as any)[0].data.cooldownUntil).toEqual(new Date("2026-10-08T00:30:00Z"));
  });
});
