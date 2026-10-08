import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TranscriptProviderResolver, transcriptProvidersFromEnv } from "./transcript-config.js";
import { encryptSecret } from "./secret-crypto.js";
import type { ApifyService } from "./apify.service.js";
import type { PrismaService } from "./prisma.service.js";

let previousKey: string | undefined;
beforeAll(() => {
  previousKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
  process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
});
afterAll(() => {
  if (previousKey === undefined) delete process.env.PERSISTENCE_ENCRYPTION_KEY;
  else process.env.PERSISTENCE_ENCRYPTION_KEY = previousKey;
});

type Row = { id: string; encryptedSecret: string; scope?: string; ownerUserId?: string };
const setup = (opts: { apify?: Row[]; elevenlabs?: Row[]; env?: Record<string, string> } = {}) => {
  const apifyRows = opts.apify ?? [];
  const apify = {
    usableAccount: vi.fn(async (id: string) => {
      const row = apifyRows.find((item) => item.id === id);
      return row ? { ok: true as const, data: { id: row.id, encryptedSecret: row.encryptedSecret } } : { ok: false as const, code: "PROVIDER_NOT_CONFIGURED" as const, message: "x", status: 503 };
    }),
    findAccountForUser: vi.fn(async () => (apifyRows[0] ? { id: apifyRows[0].id, encryptedSecret: apifyRows[0].encryptedSecret } : null)),
  };
  const prisma = {
    providerAccount: {
      findMany: vi.fn(async () => (opts.elevenlabs ?? []).map(({ id, encryptedSecret }) => ({ id, encryptedSecret }))),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = apifyRows.find((item) => item.id === where.id);
        return row && (row.scope === "organization" || row.ownerUserId === "u1") ? { id: row.id } : null;
      }),
    },
  };
  const resolver = new TranscriptProviderResolver(apify as unknown as ApifyService, prisma as unknown as PrismaService, () => opts.env ?? {});
  return { resolver, apify, prisma };
};
const staff = { userId: "u1", role: "staff" as const };

describe("transcript providers from Provider Settings", () => {
  it("TikTok: the user's verified Apify account (the form's first when they may use it), no .env needed", async () => {
    const own = { id: "apify-own", encryptedSecret: encryptSecret("apify_api_own"), scope: "personal", ownerUserId: "u1" };
    const org = { id: "apify-org", encryptedSecret: encryptSecret("apify_api_org"), scope: "organization" };
    const { resolver, apify } = setup({ apify: [org, own] });
    expect((await resolver.video({ ...staff, mediaAccountId: "apify-own" }))?.id).toBe("apify");
    expect(apify.usableAccount).toHaveBeenCalledWith("apify-own");
    expect(apify.findAccountForUser).not.toHaveBeenCalled();
    // a form account the user may not see is ignored: the visible default is used
    const other = { id: "apify-other", encryptedSecret: encryptSecret("apify_api_other"), scope: "personal", ownerUserId: "someone-else" };
    const fallback = setup({ apify: [org, other] });
    expect((await fallback.resolver.video({ ...staff, mediaAccountId: "apify-other" }))?.id).toBe("apify");
    expect(fallback.apify.findAccountForUser).toHaveBeenCalledWith("u1", "staff");
  });

  it("TikTok: no account -> TIKTOK_APIFY_TOKEN; nothing -> not configured; TIKTOK_SOURCE_PROVIDER=mock forces the mock", async () => {
    expect((await setup({ env: { TIKTOK_APIFY_TOKEN: "apify_api_env" } }).resolver.video(staff))?.id).toBe("apify");
    expect(await setup().resolver.video(staff)).toBeNull();
    const forced = setup({ apify: [{ id: "a", encryptedSecret: encryptSecret("t"), scope: "organization" }], env: { TIKTOK_SOURCE_PROVIDER: "mock" } });
    expect((await forced.resolver.video(staff))?.id).toBe("mock");
    expect(forced.apify.findAccountForUser).not.toHaveBeenCalled();
  });

  it("speech-to-text: the user's verified ElevenLabs account (the form's voice account first) -> Scribe; else env; else none", async () => {
    const { resolver, prisma } = setup({ elevenlabs: [{ id: "el-a", encryptedSecret: encryptSecret("sk_a") }, { id: "el-b", encryptedSecret: encryptSecret("sk_b") }] });
    expect((await resolver.stt({ ...staff, voiceAccountId: "el-b" }))?.id).toBe("elevenlabs_scribe");
    const where = (prisma.providerAccount.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ provider: "elevenlabs", role: "tts", deletedAt: null, enabled: true, OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: "u1" }] });
    expect((await setup({ env: { ELEVENLABS_STT_API_KEY: "sk_env" } }).resolver.stt(staff))?.id).toBe("elevenlabs_scribe");
    expect(await setup().resolver.stt(staff)).toBeNull();
    expect((await setup({ env: { STT_PROVIDER: "mock" } }).resolver.stt(staff))?.id).toBe("mock");
  });

  it("env-only helper keeps working (scripts / tests)", () => {
    expect(transcriptProvidersFromEnv({})).toEqual({ video: null, stt: null });
    expect(transcriptProvidersFromEnv({ TIKTOK_APIFY_TOKEN: "t", ELEVENLABS_STT_API_KEY: "k" })).toMatchObject({ video: { id: "apify" }, stt: { id: "elevenlabs_scribe" } });
  });
});
