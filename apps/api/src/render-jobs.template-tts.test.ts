/**
 * VE2E-47: RenderJobsService rules for a template audio element that carries a Creatomate-side TTS
 * `provider`. Creatomate is a fetch stub - no real provider call. Lean prisma stub (same shape as
 * render-jobs.service.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderJobsService } from "./render-jobs.service.js";
import type { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import type { MediaDeliveryService } from "./media-delivery.service.js";
import * as secretCrypto from "./secret-crypto.js";

const projectId = "project-1";
const templateSnapshotId = "snap-tts";
const providerAccountId = "account-1";
const PROVIDER = "elevenlabs model_id=eleven_multilingual_v2 voice_id=XrExE9yKIg1WjnnlVkGX";

const baseSlots = [
  { key: "Text-1.text", kind: "text", label: "Text-1.text", required: true },
  { key: "Video-1.source", kind: "video", label: "Video-1.source", required: true },
  { key: "Voiceover-1.source", kind: "audio", label: "Voiceover-1.source", required: false },
  { key: "Voiceover-2.source", kind: "audio", label: "Voiceover-2.source", required: false },
];
const rawTemplate = {
  elements: [
    { name: "Voiceover-1", type: "audio", source: "", provider: PROVIDER, dynamic: true },
    { name: "Voiceover-2", type: "audio", source: "", provider: PROVIDER, dynamic: true },
  ],
};
const scene = (n: number, withAudio: boolean) => ({
  sceneId: `s${n}`, orderIndex: n, mediaAssetVersionId: null, audioVersionId: withAudio ? "audio-1" : null, subtitleVersionId: null, screenTextOverride: `Cảnh ${n}`, annotation: null,
});

describe("VE2E-47 RenderJobsService template TTS", () => {
  let prisma: any;
  let service: RenderJobsService;
  let snapshotRow: any;
  let jobs: Map<string, any>;
  let timelineRows: Map<string, any>;
  let previousBaseUrl: string | undefined;

  const fetchOk = () => vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
  const audioAssignments = [
    { modificationKey: "Text-1.text", kind: "text" as const, text: "Xin chào" },
    { modificationKey: "Video-1.source", kind: "video" as const, mediaAssetVersionId: "asset-1" },
    { modificationKey: "Voiceover-1.source", kind: "audio" as const, mediaAssetVersionId: "asset-audio" },
  ];

  beforeEach(() => {
    previousBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://api.lyonix.local";
    jobs = new Map();
    timelineRows = new Map();
    snapshotRow = { id: templateSnapshotId, externalTemplateId: "tpl_jp", providerAccountId, modifications: baseSlots, rawTemplate };
    let seq = 0;
    prisma = {
      user: { findUnique: vi.fn(async () => ({ role: "staff" })) },
      project: { findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null) },
      providerAccount: { findFirst: async () => ({ id: providerAccountId, encryptedSecret: "encrypted", deletedAt: null }) },
      templateSnapshot: { findUnique: async ({ where }: any) => (where.id === templateSnapshotId ? snapshotRow : null) },
      mediaAssetVersion: {
        findFirst: async ({ where }: any) => (["asset-1", "asset-audio"].includes(where.id) ? { id: where.id, projectId, deletedAt: null } : null),
        findMany: async ({ where }: any) => [{ id: "asset-audio", projectId, kind: "audio", durationMs: 2000 }].filter((r) => where.id.in.includes(r.id)),
      },
      audioVersion: { findMany: async ({ where }: any) => [{ id: "audio-1", mediaAssetVersionId: "asset-audio", durationMs: 2000 }].filter((r) => where.id.in.includes(r.id)) },
      sceneDraftVersion: { findMany: async () => [] },
      timelineVersion: { findUnique: vi.fn(async ({ where }: any) => timelineRows.get(where.id) ?? null) },
      renderJob: {
        create: vi.fn(async ({ data }: any) => {
          const id = `job-${++seq}`;
          const row = { id, attempts: 1, progress: null, resultUrl: null, resultExpiresAt: null, costAmount: null, costCurrency: null, renderDurationMs: null, lastError: null, externalJobId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
          jobs.set(id, row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return jobs.get(where.id) ?? null;
          if (where.requestFingerprint) return [...jobs.values()].find((r) => r.requestFingerprint === where.requestFingerprint) ?? null;
          if (where.webhookToken) return [...jobs.values()].find((r) => r.webhookToken === where.webhookToken) ?? null;
          return null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const updated = { ...jobs.get(where.id), ...data };
          jobs.set(where.id, updated);
          return updated;
        }),
        count: vi.fn(async () => 0),
      },
      renderWebhookEvent: { create: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const templates = { usableAccount: vi.fn(async () => ({ ok: true as const, data: { id: providerAccountId, encryptedSecret: "encrypted", provider: "creatomate" as const } })) };
    const mediaDelivery = { issueToken: vi.fn(async () => ({ token: "tok", url: "https://api.lyonix.local/api/v1/media-delivery/tok", path: "/api/v1/media-delivery/tok", expiresAt: new Date().toISOString() })) };
    service = new RenderJobsService(prisma, { forUser: async () => ({ projectIds: [projectId] }) } as never, templates as unknown as CreatomateTemplatesService, mediaDelivery as unknown as MediaDeliveryService);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("ctm-test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  });

  it("emits <name>.provider = \"\" next to <name>.source for a TTS audio slot LyOnix fills (slots pinned before VE2E-47: backfilled from rawTemplate)", async () => {
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.submit(projectId, "user-1", "staff", {
      templateSnapshotId, providerAccountId, assignments: audioAssignments, allowTemplateTts: true,
    });
    expect(outcome.ok).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.modifications["Voiceover-1.source"]).toBe("https://api.lyonix.local/api/v1/media-delivery/tok");
    expect(body.modifications["Voiceover-1.provider"]).toBe("");
    // the unfilled slot is only tolerated because allowTemplateTts was set; it gets no override of its own
    expect(body.modifications).not.toHaveProperty("Voiceover-2.provider");
  });

  it("fails closed with TEMPLATE_TTS_CONFLICT (no signed URL, no RenderJob, no Creatomate call) when a TTS slot gets no LyOnix audio", async () => {
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments: audioAssignments });
    expect(outcome).toMatchObject({ ok: false, code: "TEMPLATE_TTS_CONFLICT", message: expect.stringContaining("Voiceover-2.source") });
    expect(prisma.renderJob.create).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders when every TTS slot is filled by LyOnix audio and overrides each provider", async () => {
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.submit(projectId, "user-1", "staff", {
      templateSnapshotId, providerAccountId,
      assignments: [...audioAssignments, { modificationKey: "Voiceover-2.source", kind: "audio", mediaAssetVersionId: "asset-audio" }],
    });
    expect(outcome.ok).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.modifications["Voiceover-1.provider"]).toBe("");
    expect(body.modifications["Voiceover-2.provider"]).toBe("");
  });

  it("template without any provider: payload has no .provider keys and never conflicts (unchanged)", async () => {
    snapshotRow = { ...snapshotRow, rawTemplate: { elements: [{ name: "Voiceover-1", type: "audio", dynamic: true }] }, modifications: baseSlots.slice(0, 3) };
    const fetchMock = fetchOk();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments: audioAssignments.slice(0, 2) });
    expect(outcome.ok).toBe(true);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(Object.keys(body.modifications).filter((k) => k.endsWith(".provider"))).toEqual([]);
  });

  describe("timeline / Auto path", () => {
    const timeline = (scenes: unknown[]) => ({ id: "tl-1", projectId, status: "approved", templateSnapshotId, scenes, optionValues: {} });

    it("submitFromTimelineVersion: scene voices fill the slots + provider override; a scene without voice fails closed before submit", async () => {
      const fetchMock = fetchOk();
      vi.stubGlobal("fetch", fetchMock);
      snapshotRow = { ...snapshotRow, modifications: baseSlots.filter((s) => s.kind !== "video") .map((s) => ({ ...s, required: false })) };
      timelineRows.set("tl-1", timeline([scene(0, true), scene(1, true)]));
      const ok = await service.submitFromTimelineVersion(projectId, "tl-1", "user-1", "staff", { providerAccountId });
      expect(ok.ok).toBe(true);
      const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(body.modifications["Voiceover-1.provider"]).toBe("");
      expect(body.modifications["Voiceover-2.provider"]).toBe("");

      fetchMock.mockClear();
      prisma.renderJob.create.mockClear();
      timelineRows.set("tl-1", timeline([scene(0, true), scene(1, false)]));
      const blocked = await service.submitFromTimelineVersion(projectId, "tl-1", "user-1", "staff", { providerAccountId });
      expect(blocked).toMatchObject({ ok: false, code: "TEMPLATE_TTS_CONFLICT" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
    });

    it("async enqueue preflight (VE2E-43) fails BEFORE creating the RenderJob; allowTemplateTts opts in", async () => {
      snapshotRow = { ...snapshotRow, modifications: baseSlots.filter((s) => s.kind !== "video").map((s) => ({ ...s, required: false })) };
      timelineRows.set("tl-1", timeline([scene(0, true), scene(1, false)]));
      const blocked = await service.enqueueTimelineRender(projectId, "tl-1", "user-1", "staff", { providerAccountId }, "template");
      expect(blocked).toMatchObject({ ok: false, code: "TEMPLATE_TTS_CONFLICT", status: 409 });
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
      expect(jobs.size).toBe(0);

      const allowed = await service.enqueueTimelineRender(projectId, "tl-1", "user-1", "staff", { providerAccountId, allowTemplateTts: true }, "template");
      expect(allowed).toMatchObject({ ok: true, data: { status: "preparing_clips" } });
      expect(jobs.size).toBe(1);
      expect([...jobs.values()][0].modificationsPayload).toMatchObject({ allowTemplateTts: true });
    });
  });

  describe("Creatomate-side render failure mapping (webhook path)", () => {
    const fail = async (errorMessage: string) => {
      vi.stubGlobal("fetch", fetchOk());
      const submitted = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments: audioAssignments, allowTemplateTts: true });
      if (!submitted.ok) throw new Error("setup failed");
      vi.unstubAllGlobals();
      const row = jobs.get(submitted.data.id);
      await service.handleWebhook(row.webhookToken, { id: "rnd_1", status: "failed", error_message: errorMessage });
      return jobs.get(submitted.data.id);
    };

    it("ElevenLabs integration missing -> TEMPLATE_TTS_FAILED with the real message", async () => {
      const row = await fail("There is no third-party integration set up for ElevenLabs");
      expect(row.status).toBe("failed");
      expect(row.lastError).toMatchObject({ code: "TEMPLATE_TTS_FAILED", message: expect.stringContaining("no third-party integration set up for ElevenLabs") });
    });

    it("ElevenLabs quota exceeded -> PROVIDER_QUOTA_EXHAUSTED", async () => {
      const row = await fail("ElevenLabs quota_exceeded: 0 of 10000 credits remaining, 118 required");
      expect(row.lastError).toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED", message: expect.stringContaining("118 required") });
    });

    it("an unrelated failure keeps the previous PROVIDER_SUBMIT_UNKNOWN code", async () => {
      const row = await fail("Media file could not be decoded");
      expect(row.lastError).toMatchObject({ code: "PROVIDER_SUBMIT_UNKNOWN", message: "Media file could not be decoded" });
    });
  });
});
