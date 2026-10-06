import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import * as secretCrypto from "./secret-crypto.js";

const accountRow = (overrides: Record<string, unknown> = {}) => ({
  id: "account-1",
  provider: "creatomate",
  role: "render",
  status: "verified",
  encryptedSecret: "encrypted",
  isFake: false,
  deletedAt: null,
  ...overrides,
});

describe("CreatomateTemplatesService", () => {
  let prisma: any;
  let service: CreatomateTemplatesService;

  beforeEach(() => {
    prisma = {
      providerAccount: { findFirst: async () => accountRow() },
      templateSnapshot: {
        create: vi.fn(async ({ data }: any) => ({ id: "snap-1", capturedAt: new Date("2026-09-24T00:00:00Z"), ...data })),
        findUnique: vi.fn(async ({ where }: any) => (where.id === "snap-1" ? { id: "snap-1", externalTemplateId: "tpl_1", name: "Bold caption", previewUrl: null, modifications: [{ key: "Text-1.text", kind: "text", label: "Text-1.text", required: true }], capturedAt: new Date("2026-09-24T00:00:00Z") } : null)),
      },
    };
    service = new CreatomateTemplatesService(prisma);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("ctm-test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("usableAccount", () => {
    it("fails fast with PROVIDER_NOT_CONFIGURED when the account does not exist", async () => {
      prisma.providerAccount.findFirst = async () => null;
      const outcome = await service.usableAccount("missing");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED when the account is unverified", async () => {
      prisma.providerAccount.findFirst = async () => accountRow({ status: "unverified" });
      const outcome = await service.usableAccount("account-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    });

    it("rejects an account that is not creatomate/render", async () => {
      prisma.providerAccount.findFirst = async () => accountRow({ provider: "pexels", role: "visual" });
      const outcome = await service.usableAccount("account-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    });
  });

  describe("listTemplates", () => {
    it("lists templates from Creatomate", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "tpl_1", name: "Bold caption" }]), { status: 200 })));
      const outcome = await service.listTemplates("account-1");
      expect(outcome).toMatchObject({ ok: true, data: [{ externalTemplateId: "tpl_1", name: "Bold caption" }] });
    });

    it("maps a 401 to PROVIDER_AUTH_INVALID", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })));
      const outcome = await service.listTemplates("account-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
    });
  });

  describe("snapshot", () => {
    it("re-fetches the template live, derives modification slots, and persists an immutable snapshot", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        id: "tpl_1",
        name: "Bold caption",
        preview_image_url: "https://cdn.creatomate.com/tpl_1.jpg",
        source: { elements: [{ name: "Text-1", type: "text", dynamic: true }, { name: "Video-1", type: "video", dynamic: true }] },
      }), { status: 200 })));
      const outcome = await service.snapshot("account-1", "tpl_1", "user-1");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.data.modifications.map((m) => m.key).sort()).toEqual(["Text-1.fill_color", "Text-1.font_family", "Text-1.text", "Video-1.source", "Video-1.volume"]);
      expect(prisma.templateSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ providerAccountId: "account-1", externalTemplateId: "tpl_1", createdByUserId: "user-1" }),
      }));
    });

    it("fails when the template has no derivable modification slots (no fabricated defaults)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "tpl_2", name: "Empty", source: { elements: [] } }), { status: 200 })));
      const outcome = await service.snapshot("account-1", "tpl_2", "user-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_SCHEMA_INVALID" });
      expect(prisma.templateSnapshot.create).not.toHaveBeenCalled();
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED for an unverified account, without calling Creatomate", async () => {
      prisma.providerAccount.findFirst = async () => accountRow({ status: "unverified" });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.snapshot("account-1", "tpl_1", "user-1");
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("getSnapshot", () => {
    it("returns an existing snapshot", async () => {
      const outcome = await service.getSnapshot("snap-1");
      expect(outcome).toMatchObject({ ok: true, data: { id: "snap-1", externalTemplateId: "tpl_1" } });
    });

    it("returns NOT_FOUND for a missing snapshot", async () => {
      const outcome = await service.getSnapshot("missing");
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("VE2E-93: sends the template's caption style defaults - LyOnix from its recipe, Creatomate from its caption element, none for Orshot", async () => {
      const row = (engine: string, rawTemplate: unknown) => ({ id: "snap-1", externalTemplateId: "x", name: "T", previewUrl: null, modifications: [], capturedAt: new Date(), engine, rolloutPercent: 0, fallbackSnapshotIds: [], rawTemplate });
      prisma.templateSnapshot.findUnique = async () => row("lyonix", { id: "faceless-story-caption-center-jp", version: 1 });
      const lyonix = await service.getSnapshot("snap-1");
      expect(lyonix).toMatchObject({ ok: true, data: { captionStyleDefaults: { fontFamily: "Noto Sans CJK JP", fontSizePx: 76, minFontSizePx: 50, animation: "word_highlight", position: { anchor: "top", percent: 38 }, maxLines: 2 } } });

      prisma.templateSnapshot.findUnique = async () => row("creatomate", { width: 1080, height: 1920, elements: [{ type: "text", name: "Subtitles-1", font_family: "Montserrat", font_size: "5 vmin", fill_color: "#ffee00" }] });
      const creatomate = await service.getSnapshot("snap-1");
      expect(creatomate).toMatchObject({ ok: true, data: { captionStyleDefaults: { fontFamily: "Montserrat", fontSizePx: 54, fillColor: "#ffee00", animation: "none" } } });

      prisma.templateSnapshot.findUnique = async () => row("orshot", { modifications: [] });
      const orshot = await service.getSnapshot("snap-1");
      expect(orshot.ok && orshot.data).not.toHaveProperty("captionStyleDefaults");

      prisma.templateSnapshot.findUnique = async () => row("lyonix", { id: "no-such-recipe", version: 9 });
      const unknown = await service.getSnapshot("snap-1");
      expect(unknown.ok && unknown.data).not.toHaveProperty("captionStyleDefaults");
    });
  });
});
