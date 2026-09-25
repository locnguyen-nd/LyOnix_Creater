import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@lyonix/db";
import { RenderJobsService } from "./render-jobs.service.js";
import type { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import type { MediaDeliveryService } from "./media-delivery.service.js";
import * as secretCrypto from "./secret-crypto.js";

const projectId = "project-1";
const templateSnapshotId = "snap-1";
const providerAccountId = "account-1";

const slots = [
  { key: "Text-1.text", kind: "text", label: "Text-1.text", required: true },
  { key: "Video-1.source", kind: "video", label: "Video-1.source", required: true },
];

const snapshotRow = { id: templateSnapshotId, externalTemplateId: "tpl_1", providerAccountId, modifications: slots };

const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });

const assignments = [
  { modificationKey: "Text-1.text", kind: "text" as const, text: "Xin chào" },
  { modificationKey: "Video-1.source", kind: "video" as const, mediaAssetVersionId: "asset-1" },
];

describe("RenderJobsService", () => {
  let prisma: any;
  let grants: any;
  let templates: Partial<CreatomateTemplatesService>;
  let mediaDelivery: Partial<MediaDeliveryService>;
  let service: RenderJobsService;
  let renderJobRows: Map<string, any>;
  let timelineRows: Map<string, any>;
  let previousBaseUrl: string | undefined;

  beforeEach(() => {
    previousBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://api.lyonix.local";
    renderJobRows = new Map();
    timelineRows = new Map();
    let seq = 0;
    prisma = {
      project: { findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null) },
      providerAccount: { findFirst: async () => ({ id: providerAccountId, encryptedSecret: "encrypted", deletedAt: null }) },
      templateSnapshot: { findUnique: async ({ where }: any) => (where.id === templateSnapshotId ? snapshotRow : null) },
      mediaAssetVersion: {
        findFirst: async ({ where }: any) => (where.id === "asset-1" ? { id: "asset-1", projectId, deletedAt: null } : null),
        findMany: async ({ where }: any) =>
          [
            { id: "asset-1", projectId, kind: "video" },
            { id: "asset-audio", projectId, kind: "audio" },
          ].filter((r) => where.id.in.includes(r.id) && r.projectId === where.projectId),
      },
      audioVersion: { findMany: async ({ where }: any) => [{ id: "audio-1", mediaAssetVersionId: "asset-audio" }].filter((r) => where.id.in.includes(r.id)) },
      timelineVersion: { findUnique: vi.fn(async ({ where }: any) => timelineRows.get(where.id) ?? null) },
      renderJob: {
        create: vi.fn(async ({ data }: any) => {
          const existing = [...renderJobRows.values()].find((r) => r.requestFingerprint === data.requestFingerprint);
          if (existing) throw p2002();
          const id = `job-${++seq}`;
          const row = { id, attempts: 1, progress: null, resultUrl: null, resultExpiresAt: null, costAmount: null, costCurrency: null, renderDurationMs: null, lastError: null, externalJobId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
          renderJobRows.set(id, row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return renderJobRows.get(where.id) ?? null;
          if (where.requestFingerprint) return [...renderJobRows.values()].find((r) => r.requestFingerprint === where.requestFingerprint) ?? null;
          if (where.webhookToken) return [...renderJobRows.values()].find((r) => r.webhookToken === where.webhookToken) ?? null;
          return null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = renderJobRows.get(where.id);
          const updated = { ...row, ...data, updatedAt: new Date() };
          renderJobRows.set(where.id, updated);
          return updated;
        }),
        findMany: vi.fn(async () => [...renderJobRows.values()].filter((r) => !["completed", "failed", "cancelled"].includes(r.status) && r.externalJobId)),
      },
      renderWebhookEvent: {
        create: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    // Simulate the unique constraint on eventFingerprint for webhook idempotency.
    const seenFingerprints = new Set<string>();
    prisma.renderWebhookEvent.create = vi.fn(async ({ data }: any) => {
      if (seenFingerprints.has(data.eventFingerprint)) throw p2002();
      seenFingerprints.add(data.eventFingerprint);
      return {};
    });
    grants = { forUser: async () => ({ projectIds: [projectId] }) };
    templates = { usableAccount: vi.fn(async () => ({ ok: true as const, data: { id: providerAccountId, encryptedSecret: "encrypted" } })) };
    mediaDelivery = { issueToken: vi.fn(async () => ({ token: "tok", url: "https://api.lyonix.local/api/v1/media-delivery/tok", expiresAt: new Date().toISOString() })) };
    service = new RenderJobsService(prisma, grants, templates as CreatomateTemplatesService, mediaDelivery as MediaDeliveryService);
    vi.spyOn(secretCrypto, "decryptSecret").mockReturnValue("ctm-test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  });

  describe("submit", () => {
    it("builds a server-owned modifications payload (signed media URL for the video slot) and submits to Creatomate", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.data.status).toBe("queued");
      expect(outcome.data.externalJobId).toBe("rnd_1");
      expect(mediaDelivery.issueToken).toHaveBeenCalledWith("asset-1", "user-1", "staff", expect.any(Number));
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(submittedBody.modifications).toEqual({ "Text-1.text": "Xin chào", "Video-1.source": "https://api.lyonix.local/api/v1/media-delivery/tok" });
      expect(submittedBody.webhook_url).toContain("/render-webhooks/creatomate/");
    });

    it("resolves an audio-kind assignment to a signed media URL the same way as video/image (VE2E-06 narration attachment)", async () => {
      const audioSlots = [...slots, { key: "Audio-1.source", kind: "audio", label: "Audio-1.source", required: false }];
      prisma.templateSnapshot.findUnique = async ({ where }: any) => (where.id === templateSnapshotId ? { ...snapshotRow, modifications: audioSlots } : null);
      prisma.mediaAssetVersion.findFirst = async ({ where }: any) => (["asset-1", "asset-audio"].includes(where.id) ? { id: where.id, projectId, deletedAt: null } : null);
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submit(projectId, "user-1", "staff", {
        templateSnapshotId,
        providerAccountId,
        assignments: [...assignments, { modificationKey: "Audio-1.source", kind: "audio", mediaAssetVersionId: "asset-audio" }],
      });
      expect(outcome.ok).toBe(true);
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(submittedBody.modifications["Audio-1.source"]).toBe("https://api.lyonix.local/api/v1/media-delivery/tok");
    });

    it("links the created render job to a workflowRunId when the orchestrator submits directly (not part of the public contract)", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments }, "run-1");
      expect(prisma.renderJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workflowRunId: "run-1" }) }));
    });

    it("rejects a modificationKey that is not on the pinned template snapshot, without creating a render job", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submit(projectId, "user-1", "staff", {
        templateSnapshotId,
        providerAccountId,
        assignments: [{ modificationKey: "Text-99.text", kind: "text", text: "hi" }],
      });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a submission missing a required modification slot", async () => {
      const outcome = await service.submit(projectId, "user-1", "staff", {
        templateSnapshotId,
        providerAccountId,
        assignments: [{ modificationKey: "Text-1.text", kind: "text", text: "hi" }],
      });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED", message: expect.stringContaining("Video-1.source") });
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
    });

    it("preflight fails before any charge when the provider account is not usable", async () => {
      templates.usableAccount = vi.fn(async () => ({ ok: false as const, code: "PROVIDER_NOT_CONFIGURED" as const, message: "chưa verify", status: 503 }));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preflight fails before any charge when PUBLIC_BASE_URL is not configured", async () => {
      delete process.env.PUBLIC_BASE_URL;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a media assignment referencing an asset from a different project", async () => {
      prisma.mediaAssetVersion.findFirst = async () => ({ id: "asset-1", projectId: "other-project", deletedAt: null });
      const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
    });

    it("does not submit to Creatomate twice for an identical duplicate request (idempotent fingerprint)", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const issueToken = mediaDelivery.issueToken as ReturnType<typeof vi.fn>;
      issueToken
        .mockResolvedValueOnce({ token: "tok-first", url: "https://api.lyonix.local/api/v1/media-delivery/tok-first", expiresAt: new Date().toISOString() })
        .mockResolvedValueOnce({ token: "tok-retry", url: "https://api.lyonix.local/api/v1/media-delivery/tok-retry", expiresAt: new Date().toISOString() });
      const first = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      const second = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) expect(second.data.id).toBe(first.data.id);
    });

    it("does not regress a completed webhook when the initial submit response arrives late", async () => {
      const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { webhook_url: string };
        const token = new URL(body.webhook_url).pathname.split("/").at(-1)!;
        await service.handleWebhook(token, { id: "rnd_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_1.mp4" });
        return new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });

      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.data.status).toBe("completed");
    });
  });

  describe("handleWebhook", () => {
    const submitOne = async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 })));
      const outcome = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      if (!outcome.ok) throw new Error("setup submit failed");
      vi.unstubAllGlobals();
      return outcome.data;
    };

    it("rejects an unknown webhook token", async () => {
      const outcome = await service.handleWebhook("bogus-token", { status: "succeeded" });
      expect(outcome).toMatchObject({ ok: false, code: "WEBHOOK_INVALID" });
    });

    it("applies a succeeded callback and records the result URL", async () => {
      const job = await submitOne();
      const row = [...renderJobRows.values()].find((r) => r.id === job.id)!;
      const outcome = await service.handleWebhook(row.webhookToken, { id: "rnd_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_1.mp4", render_duration: 3.5 });
      expect(outcome).toMatchObject({ ok: true });
      const updated = renderJobRows.get(job.id);
      expect(updated.status).toBe("completed");
      expect(updated.resultUrl).toBe("https://cdn.creatomate.com/rnd_1.mp4");
      expect(updated.renderDurationMs).toBe(3500);
    });

    it("does not mark a render completed without a result URL", async () => {
      const job = await submitOne();
      const row = renderJobRows.get(job.id)!;

      await service.handleWebhook(row.webhookToken, { id: "rnd_1", status: "succeeded" });

      const updated = renderJobRows.get(job.id);
      expect(updated.status).not.toBe("completed");
      expect(updated.status).toBe("failed");
      expect(updated.resultUrl).toBeFalsy();
      expect(updated.lastError).toBeTruthy();
    });

    it("is a no-op on an exact-duplicate webhook delivery (inbox idempotency)", async () => {
      const job = await submitOne();
      const row = [...renderJobRows.values()].find((r) => r.id === job.id)!;
      const payload = { id: "rnd_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_1.mp4" };
      await service.handleWebhook(row.webhookToken, payload);
      const updateCallsAfterFirst = prisma.renderJob.update.mock.calls.length;
      await service.handleWebhook(row.webhookToken, payload);
      expect(prisma.renderJob.update.mock.calls.length).toBe(updateCallsAfterFirst);
    });

    it("ignores an out-of-order regression (monotonic guard)", async () => {
      const job = await submitOne();
      const row = [...renderJobRows.values()].find((r) => r.id === job.id)!;
      renderJobRows.set(job.id, { ...row, status: "rendering" });
      await service.handleWebhook(row.webhookToken, { id: "rnd_1", status: "waiting" });
      expect(renderJobRows.get(job.id).status).toBe("rendering");
    });

    it("never un-completes a terminal render on a later duplicate/late callback", async () => {
      const job = await submitOne();
      const row = [...renderJobRows.values()].find((r) => r.id === job.id)!;
      await service.handleWebhook(row.webhookToken, { id: "rnd_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_1.mp4" });
      await service.handleWebhook(row.webhookToken, { id: "rnd_1", status: "failed", error_message: "late failure" });
      expect(renderJobRows.get(job.id).status).toBe("completed");
    });
  });

  describe("get / reconcile", () => {
    it("actively reconciles a non-terminal job against live Creatomate status on GET", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 })));
      const submitted = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      if (!submitted.ok) throw new Error("setup failed");
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "rnd_1", status: "rendering", progress: 40 }), { status: 200 })));
      const outcome = await service.get(submitted.data.id, "user-1", "staff");
      expect(outcome).toMatchObject({ ok: true, data: { status: "rendering", progress: 40 } });
    });

    it("hides a render job outside the caller's project grants as not-found", async () => {
      grants = { forUser: async () => ({ projectIds: [] }) };
      service = new RenderJobsService(prisma, grants, templates as CreatomateTemplatesService, mediaDelivery as MediaDeliveryService);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 })));
      // Seed a row directly (bypassing grants) to exercise the read path.
      renderJobRows.set("job-x", { id: "job-x", projectId, templateSnapshotId, providerAccountId, requestFingerprint: "fp-x", webhookToken: "tok-x", status: "queued", externalJobId: "rnd_x", attempts: 1, progress: null, resultUrl: null, resultExpiresAt: null, costAmount: null, costCurrency: null, renderDurationMs: null, lastError: null, createdAt: new Date(), updatedAt: new Date() });
      const outcome = await service.get("job-x", "user-1", "staff");
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("reconcilePending reconciles every non-terminal job with an externalJobId", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 })));
      const a = await service.submit(projectId, "user-1", "staff", { templateSnapshotId, providerAccountId, assignments });
      if (!a.ok) throw new Error("setup failed");
      vi.unstubAllGlobals();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "rnd_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_1.mp4" }), { status: 200 })));
      const result = await service.reconcilePending();
      expect(result.reconciled).toBe(1);
      expect(renderJobRows.get(a.data.id).status).toBe("completed");
    });
  });

  describe("submitFromTimelineVersion (VE2E-07)", () => {
    const timelineVersionId = "timeline-1";

    it("resolves an approved timeline's scene bindings into assignments and submits via the same submit() path", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "asset-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: "Xin chào", annotation: null }],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(submittedBody.modifications).toEqual({ "Text-1.text": "Xin chào", "Video-1.source": "https://api.lyonix.local/api/v1/media-delivery/tok" });
    });

    it("rejects submitting a draft (not yet approved) timeline", async () => {
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId, status: "draft", templateSnapshotId, scenes: [], optionValues: {} });
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATE" });
    });

    it("rejects when the approved timeline is missing a required modification slot", async () => {
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId, status: "approved", templateSnapshotId, scenes: [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: null, audioVersionId: null, subtitleVersionId: null, screenTextOverride: null, annotation: null }], optionValues: {} });
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("returns NOT_FOUND for a timeline version belonging to a different project", async () => {
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId: "other-project", status: "approved", templateSnapshotId, scenes: [], optionValues: {} });
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });
});
