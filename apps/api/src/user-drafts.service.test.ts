import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@lyonix/db";
import { UserDraftsService } from "./user-drafts.service.js";

type Row = { id: string; userId: string; flowType: string; payload: unknown; version: number; updatedAt: Date };

describe("UserDraftsService (VE2E-124)", () => {
  let rows: Row[];
  let service: UserDraftsService;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    rows = [];
    let seq = 0;
    const userDraft = {
      findUnique: async ({ where }: any) => rows.find((r) => r.userId === where.userId_flowType.userId && r.flowType === where.userId_flowType.flowType) ?? null,
      create: async ({ data }: any) => {
        if (rows.some((r) => r.userId === data.userId && r.flowType === data.flowType)) throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
        const row = { id: `d-${++seq}`, version: 1, updatedAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) => r.userId === where.userId && r.flowType === where.flowType && r.version === where.version);
        hit.forEach((r) => { r.payload = data.payload; r.version += data.version.increment; r.updatedAt = new Date(); });
        return { count: hit.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = rows.length;
        rows = rows.filter((r) => !(r.userId === where.userId && r.flowType === where.flowType));
        return { count: before - rows.length };
      },
    };
    service = new UserDraftsService({ userDraft } as never);
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates, reads back and updates the user's own draft (version = compare-and-set token)", async () => {
    const created = await service.save("user-a", "job_new", { payload: { topic: "Messi", language: "ja" }, baseVersion: null });
    expect(created).toMatchObject({ ok: true, data: { flowType: "job_new", version: 1, payload: { topic: "Messi", language: "ja" } } });
    const updated = await service.save("user-a", "job_new", { payload: { topic: "Messi tới Mỹ", language: "ja" }, baseVersion: 1 });
    expect(updated).toMatchObject({ ok: true, data: { version: 2, payload: { topic: "Messi tới Mỹ" } } });
    await expect(service.get("user-a", "job_new")).resolves.toMatchObject({ ok: true, data: { version: 2 } });
  });

  it("a late (older) autosave can never overwrite newer state", async () => {
    await service.save("user-a", "job_new", { payload: { topic: "v1" }, baseVersion: null });
    await service.save("user-a", "job_new", { payload: { topic: "v2 newer" }, baseVersion: 1 });
    const late = await service.save("user-a", "job_new", { payload: { topic: "v1 late" }, baseVersion: 1 });
    expect(late).toMatchObject({ ok: false, code: "VERSION_CONFLICT", status: 409 });
    expect(rows[0]!.payload).toEqual({ topic: "v2 newer" });
    // a second "create" (another tab) does not overwrite either
    await expect(service.save("user-a", "job_new", { payload: { topic: "tab 2" }, baseVersion: null })).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
  });

  it("user A's draft is invisible to user B, and B cannot delete or overwrite it", async () => {
    await service.save("user-a", "job_new", { payload: { topic: "A only" }, baseVersion: null });
    await expect(service.get("user-b", "job_new")).resolves.toEqual({ ok: true, data: null });
    await expect(service.save("user-b", "job_new", { payload: { topic: "B" }, baseVersion: 1 })).resolves.toMatchObject({ ok: false, code: "VERSION_CONFLICT" });
    await expect(service.remove("user-b", "job_new")).resolves.toEqual({ ok: true, data: { deleted: false } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "user-a", payload: { topic: "A only" } });
  });

  it("stores only whitelisted form values (never a secret) and rejects a bad baseVersion or flow", async () => {
    await service.save("user-a", "job_new", { payload: { topic: "x", apiKey: "sk-123", encryptedSecret: "s", voiceId: "v1" }, baseVersion: null });
    expect(rows[0]!.payload).toEqual({ topic: "x", voiceId: "v1" });
    await expect(service.save("user-a", "job_new", { payload: {}, baseVersion: 0 })).resolves.toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    await expect(service.save("user-a", "job_new", { payload: {}, baseVersion: "1" })).resolves.toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    await expect(service.get("user-a", "other_flow")).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("deleting is idempotent (submit in another tab), and nothing here ever calls a provider", async () => {
    await service.save("user-a", "job_new", { payload: { topic: "x" }, baseVersion: null });
    await expect(service.remove("user-a", "job_new")).resolves.toEqual({ ok: true, data: { deleted: true } });
    await expect(service.remove("user-a", "job_new")).resolves.toEqual({ ok: true, data: { deleted: false } });
    await expect(service.get("user-a", "job_new")).resolves.toEqual({ ok: true, data: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
