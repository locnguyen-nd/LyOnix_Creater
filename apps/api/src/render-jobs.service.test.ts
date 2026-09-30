import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@lyonix/db";
import { DYNAMIC_STYLE_OPTION_KEYS } from "@lyonix/providers";
import { RenderJobsService } from "./render-jobs.service.js";
import type { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import type { MediaDeliveryService } from "./media-delivery.service.js";
import * as secretCrypto from "./secret-crypto.js";
import { ClipDerivativesService } from "./clip-derivatives.service.js";
import { failedClipResult, mediaAssetStore, startStubMediaWorker, type StubWorkerBehavior } from "./clip-derivatives.test-helpers.js";

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
      user: { findUnique: vi.fn(async () => ({ role: "staff" })) },
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
      audioVersion: { findMany: async ({ where }: any) => [{ id: "audio-1", mediaAssetVersionId: "asset-audio", durationMs: 4000 }].filter((r) => where.id.in.includes(r.id)) },
      // VE2E-32: no real caption segments by default - existing dynamic-composition tests below keep exercising the static-text fallback unchanged. Tests exercising the new segment wiring override this.
      subtitleVersion: { findMany: vi.fn(async () => []) },
      sceneDraftVersion: { findMany: async () => [] },
      timelineVersion: { findUnique: vi.fn(async ({ where }: any) => timelineRows.get(where.id) ?? null) },
      renderJob: {
        findFirst: vi.fn(async ({ where }: any) => [...renderJobRows.values()].find((row) => row.status === where.status && (where.status !== "preparing_clips" || !row.preparationLeaseUntil || row.preparationLeaseUntil < new Date())) ?? null),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const row = renderJobRows.get(where.id);
          if (!row || row.status !== where.status || ("preparationLeaseUntil" in where && row.preparationLeaseUntil !== where.preparationLeaseUntil)) return { count: 0 };
          renderJobRows.set(where.id, { ...row, ...data, updatedAt: new Date() });
          return { count: 1 };
        }),
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
          const updated = { ...row, ...data, clipsReady: typeof data.clipsReady === "object" ? (row.clipsReady ?? 0) + data.clipsReady.increment : (data.clipsReady ?? row.clipsReady), updatedAt: new Date() };
          renderJobRows.set(where.id, updated);
          return updated;
        }),
        count: vi.fn(async ({ where }: any) => [...renderJobRows.values()].filter((r) => r.workflowRunId === where.workflowRunId && r.status === where.status).length),
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

  /**
   * VE2E-37: re-creates `service` with a real ClipDerivativesService talking to a stub media-worker over
   * InMemoryMediaJobBroker, backed by an in-memory MediaAssetVersion store (asset-1 = 50MB Pexels video).
   * Delivery URLs embed the asset id so a test can see which file Creatomate would fetch.
   */
  const withStubClipDerivatives = async (behavior?: StubWorkerBehavior, parentOrigin = "pexels") => {
    const worker = await startStubMediaWorker(behavior);
    const store = mediaAssetStore([
      { id: "asset-1", projectId, kind: "video", origin: parentOrigin, bytes: 50_000_000, relativePath: "projects/project-1/assets/src.mp4", originalFileName: "src.mp4" },
      { id: "asset-audio", projectId, kind: "audio", origin: "generated", bytes: 1000, relativePath: "projects/project-1/assets/a.mp3", originalFileName: "a.mp3" },
    ]);
    prisma.mediaAssetVersion = store;
    mediaDelivery.issueToken = vi.fn(async (id: string) => ({ token: id, url: `https://api.lyonix.local/api/v1/media-delivery/${id}`, expiresAt: new Date().toISOString() })) as never;
    const clip = new ClipDerivativesService(prisma, worker.client);
    const logs: string[] = [];
    clip.log = (message) => logs.push(message);
    service = new RenderJobsService(prisma, grants, templates as CreatomateTemplatesService, mediaDelivery as MediaDeliveryService, clip);
    return { worker, store, logs };
  };

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

    it("captures the Creatomate snapshot_url for the finished-video library thumbnail (VE2E-19)", async () => {
      const job = await submitOne();
      const row = [...renderJobRows.values()].find((r) => r.id === job.id)!;
      await service.handleWebhook(row.webhookToken, {
        id: "rnd_1",
        status: "succeeded",
        url: "https://cdn.creatomate.com/rnd_1.mp4",
        snapshot_url: "https://cdn.creatomate.com/rnd_1.jpg",
      });
      const updated = renderJobRows.get(job.id);
      expect(updated.snapshotUrl).toBe("https://cdn.creatomate.com/rnd_1.jpg");
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

    it("VE2E-42/37: a ranged scene renders its trimmed derivative instead of the full source, and links workflowRunId for Auto", async () => {
      const legacyScene = { sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "asset-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: "Xin chào", annotation: null };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const cut = await withStubClipDerivatives();
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId, status: "approved", templateSnapshotId, scenes: [legacyScene], optionValues: {} });
      await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId, idempotencyKey: "a" });
      expect(cut.worker.jobs).toHaveLength(0); // no range -> exactly today's behavior, no media-worker call
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId, projectId, status: "approved", templateSnapshotId, optionValues: {},
        scenes: [{ ...legacyScene, excluded: false, segmentId: "g1", sourceStartMs: 2000, sourceDurationMs: 3000 }],
        segments: [{ segmentId: "g1", sceneIds: ["s1"], mediaAssetVersionId: "asset-1", subject: null, priority: 1 }],
        workflowRunId: "run-1",
      });
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId, idempotencyKey: "b" }, "run-1");
      expect(outcome.ok).toBe(true);
      const legacyBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      const rangedBody = JSON.parse(String((fetchMock.mock.calls[1] as any)[1].body));
      expect(legacyBody.modifications["Video-1.source"]).toBe("https://api.lyonix.local/api/v1/media-delivery/asset-1");
      expect(rangedBody.modifications["Video-1.source"]).toBe("https://api.lyonix.local/api/v1/media-delivery/deriv-1");
      expect(rangedBody.modifications["Text-1.text"]).toBe(legacyBody.modifications["Text-1.text"]);
      expect(cut.worker.jobs).toHaveLength(1);
      expect(cut.worker.jobs[0]).toMatchObject({ startMs: 2000, durationMs: 3000, stripAudio: true, source: { mediaAssetVersionId: "asset-1" } });
      expect(prisma.renderJob.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ workflowRunId: "run-1" }) }));
    });

    it("returns NOT_FOUND for a timeline version belonging to a different project", async () => {
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId: "other-project", status: "approved", templateSnapshotId, scenes: [], optionValues: {} });
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });

  describe("VE2E-43 durable timeline queue", () => {
    const rangedTimeline = () => ({
      id: "timeline-ranged", projectId, status: "approved", templateSnapshotId,
      scenes: [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "asset-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: "Xin chào", annotation: null, sourceStartMs: 2000, sourceDurationMs: 3000 }],
      optionValues: {},
    });
    it("returns a preparing job without calling Creatomate, deduplicates submit, then submits in worker", async () => {
      timelineRows.set("timeline-async", {
        id: "timeline-async", projectId, status: "approved", templateSnapshotId,
        scenes: [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "asset-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: "Xin chào", annotation: null }],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_async", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const first = await service.enqueueTimelineRender(projectId, "timeline-async", "user-1", "staff", { providerAccountId }, "template");
      expect(first).toMatchObject({ ok: true, data: { status: "preparing_clips", clipPreparation: { clipsTotal: 0, clipsReady: 0 } } });
      expect(fetchMock).not.toHaveBeenCalled();
      const second = await service.enqueueTimelineRender(projectId, "timeline-async", "user-1", "staff", { providerAccountId }, "template");
      expect(second).toMatchObject({ ok: true, data: { id: first.ok ? first.data.id : "" } });
      expect(renderJobRows.size).toBe(1);
      expect(await service.processNextPreparation()).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(renderJobRows.get(first.ok ? first.data.id : "")?.status).toBe("queued");
    });

    it("reports cut progress and submits only the derivative after worker processing", async () => {
      const cut = await withStubClipDerivatives();
      timelineRows.set("timeline-ranged", rangedTimeline());
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_async", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const queued = await service.enqueueTimelineRender(projectId, "timeline-ranged", "user-1", "staff", { providerAccountId }, "template");
      expect(queued).toMatchObject({ ok: true, data: { status: "preparing_clips", clipPreparation: { clipsTotal: 1, clipsReady: 0 } } });
      expect(cut.worker.jobs).toHaveLength(0);
      await service.processNextPreparation();
      expect(cut.worker.jobs).toHaveLength(1);
      const row = renderJobRows.get(queued.ok ? queued.data.id : "");
      expect(row).toMatchObject({ status: "queued", clipsReady: 1 });
      const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(body.modifications["Video-1.source"]).toContain("deriv-1");
    });

    it("records a per-scene worker error and never submits the full source", async () => {
      await withStubClipDerivatives((job) => failedClipResult(job, "RANGE_OUT_OF_BOUNDS", false));
      timelineRows.set("timeline-ranged", rangedTimeline());
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const queued = await service.enqueueTimelineRender(projectId, "timeline-ranged", "user-1", "staff", { providerAccountId }, "template");
      await service.processNextPreparation();
      const row = renderJobRows.get(queued.ok ? queued.data.id : "");
      expect(row.status).toBe("failed");
      expect(row.clipFailures).toMatchObject([{ sceneId: "s1", code: "VALIDATION_FAILED" }]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reclaims an expired preparation lease after restart", async () => {
      timelineRows.set("timeline-ranged", rangedTimeline());
      await withStubClipDerivatives();
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_recovered", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const queued = await service.enqueueTimelineRender(projectId, "timeline-ranged", "user-1", "staff", { providerAccountId }, "template");
      const id = queued.ok ? queued.data.id : "";
      renderJobRows.set(id, { ...renderJobRows.get(id), preparationLeaseUntil: new Date(Date.now() - 1000), clipFailures: [{ sceneId: "s1", code: "OLD", message: "prior attempt" }] });
      expect(await service.processNextPreparation()).toBe(true);
      expect(renderJobRows.get(id)).toMatchObject({ status: "queued", clipsReady: 1, clipFailures: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const plainTimeline = () => ({
      id: "timeline-plain", projectId, status: "approved", templateSnapshotId,
      scenes: [{ sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "asset-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: "Xin chào", annotation: null }],
      optionValues: {},
    });

    it("P1-2: Auto retry after a failed job creates a new job; a duplicate submit while it runs dedupes", async () => {
      timelineRows.set("timeline-plain", plainTimeline());
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_retry", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const enqueue = () => service.enqueueTimelineRender(projectId, "timeline-plain", "user-1", "staff", { providerAccountId, idempotencyKey: "run-fp" }, "template", "run-1");
      const first = await enqueue();
      const firstId = first.ok ? first.data.id : "";
      // Duplicate while non-terminal -> same job.
      const dup = await enqueue();
      expect(dup.ok && dup.data.id).toBe(firstId);
      renderJobRows.set(firstId, { ...renderJobRows.get(firstId), status: "failed", lastError: { code: "MEDIA_PREPARE_FAILED", message: "x", retryable: true } });
      // User retry -> new job.
      const retry = await enqueue();
      expect(retry.ok && retry.data.id).not.toBe(firstId);
      expect(retry).toMatchObject({ ok: true, data: { status: "preparing_clips" } });
      expect(renderJobRows.size).toBe(2);
      // Duplicate while the new one is running -> still deduped, no third job.
      const dup2 = await enqueue();
      expect(dup2.ok && dup2.data.id).toBe(retry.ok ? retry.data.id : "");
      expect(renderJobRows.size).toBe(2);
      // And it can actually be processed (preparation picks the new job).
      await service.processNextPreparation();
      expect(renderJobRows.get(retry.ok ? retry.data.id : "")?.status).toBe("queued");
    });

    it("P2: clipsTotal counts parent+range+stripAudio so clipsReady never exceeds it", async () => {
      timelineRows.set("timeline-dup", {
        id: "timeline-dup", projectId, status: "approved", templateSnapshotId,
        scenes: [
          { sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "asset-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: "a", annotation: null, sourceStartMs: 0, sourceDurationMs: 2000 },
          { sceneId: "s2", orderIndex: 1, mediaAssetVersionId: "asset-1", audioVersionId: null, subtitleVersionId: null, screenTextOverride: "b", annotation: null, sourceStartMs: 0, sourceDurationMs: 2000 },
        ],
        optionValues: {},
      });
      const queued = await service.enqueueTimelineRender(projectId, "timeline-dup", "user-1", "staff", { providerAccountId }, "template");
      // Same parent+range+stripAudio (template default = stripped) for both scenes -> at most one cut.
      expect(queued.ok && queued.data.clipPreparation.clipsTotal).toBeLessThanOrEqual(1);
    });

    it("P1-1: a reclaimed second worker (INVALID_STATE) never fails a job the first worker already submitted", async () => {
      timelineRows.set("timeline-plain", plainTimeline());
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const queued = await service.enqueueTimelineRender(projectId, "timeline-plain", "user-1", "staff", { providerAccountId }, "template");
      const id = queued.ok ? queued.data.id : "";
      // While worker 2 has claimed the (reclaimed) lease, worker 1 finishes its provider submit.
      prisma.user.findUnique = vi.fn(async () => {
        renderJobRows.set(id, { ...renderJobRows.get(id), status: "queued", externalJobId: "rnd_first", submittedAt: new Date() });
        return { role: "staff" };
      });
      expect(await service.processNextPreparation()).toBe(true);
      expect(renderJobRows.get(id)).toMatchObject({ status: "queued", externalJobId: "rnd_first" });
      expect(renderJobRows.get(id).lastError).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("P1-1: an exception after the provider accepted the render does not mark the job failed", async () => {
      timelineRows.set("timeline-plain", plainTimeline());
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_ok", status: "planned" }]), { status: 200 })));
      const queued = await service.enqueueTimelineRender(projectId, "timeline-plain", "user-1", "staff", { providerAccountId }, "template");
      const id = queued.ok ? queued.data.id : "";
      const original = service.submitFromTimelineVersion.bind(service);
      vi.spyOn(service, "submitFromTimelineVersion").mockImplementation(async (...args) => {
        await original(...args);
        throw new Error("db connection lost after provider success");
      });
      await service.processNextPreparation();
      expect(renderJobRows.get(id)).toMatchObject({ status: "queued", externalJobId: "rnd_ok" });
    });

    it("P1-1: a genuine preparation failure still marks a preparing_clips job failed", async () => {
      timelineRows.set("timeline-plain", plainTimeline());
      const queued = await service.enqueueTimelineRender(projectId, "timeline-plain", "user-1", "staff", { providerAccountId }, "template");
      const id = queued.ok ? queued.data.id : "";
      vi.spyOn(service, "submitFromTimelineVersion").mockRejectedValue(new Error("boom"));
      await service.processNextPreparation();
      expect(renderJobRows.get(id)).toMatchObject({ status: "failed", lastError: { code: "MEDIA_PREPARE_FAILED", retryable: true } });
    });
  });

  describe("submitDynamicFromTimeline", () => {
    const timelineVersionId = "timeline-dyn-1";
    const sceneRow = (overrides: Record<string, unknown>) => ({
      sceneId: "s1",
      orderIndex: 0,
      mediaAssetVersionId: "asset-1",
      audioVersionId: "audio-1",
      subtitleVersionId: null,
      screenTextOverride: "Xin chào",
      annotation: null,
      excluded: false,
      ...overrides,
    });

    beforeEach(() => {
      prisma.templateSnapshot.findUnique = async ({ where }: any) => (where.id === templateSnapshotId ? { ...snapshotRow, rawTemplate: null } : null);
    });

    it("builds one composition per renderable scene sized to that scene's own audio duration, never the template's fixed slot count", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1" }), sceneRow({ sceneId: "s2", orderIndex: 1, screenTextOverride: "Cảnh hai" })],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(submittedBody.source.width).toBe(1080);
      expect(submittedBody.source.height).toBe(1920);
      expect(submittedBody.source.elements).toHaveLength(2);
      expect(submittedBody.source.elements[0].duration).toBe(4);
      expect(submittedBody.source.elements[0].elements[1].text).toBe("Xin chào");
      expect(submittedBody.source.elements[1].elements[1].text).toBe("Cảnh hai");
    });

    it("VE2E-32: uses the scene's real voice-timed caption segments when no Studio override is set", async () => {
      prisma.subtitleVersion.findMany = vi.fn(async ({ where }: any) =>
        where.audioVersionId.in.includes("audio-1")
          ? [{ audioVersionId: "audio-1", segments: [{ text: "Messi is a football player.", startMs: 0, endMs: 1800 }, { text: "He plays for Inter Miami now.", startMs: 1800, endMs: 3600 }] }]
          : [],
      );
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1", screenTextOverride: null })],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome.ok).toBe(true);
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      const textNodes = submittedBody.source.elements[0].elements.filter((el: any) => el.type === "text");
      expect(textNodes).toHaveLength(2);
      expect(textNodes[0]).toMatchObject({ text: "Messi is a football player.", time: 0, duration: 1.8 });
      expect(textNodes[1]).toMatchObject({ text: "He plays for Inter Miami now.", time: 1.8, duration: 1.8 });
    });

    it("VE2E-32: a Studio screenTextOverride always stays one static block, even when real caption segments exist", async () => {
      prisma.subtitleVersion.findMany = vi.fn(async () => [
        { audioVersionId: "audio-1", segments: [{ text: "Messi is a football player.", startMs: 0, endMs: 1800 }, { text: "He plays for Inter Miami now.", startMs: 1800, endMs: 3600 }] },
      ]);
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1", screenTextOverride: "Custom override" })],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome.ok).toBe(true);
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      const textNodes = submittedBody.source.elements[0].elements.filter((el: any) => el.type === "text");
      expect(textNodes).toHaveLength(1);
      expect(textNodes[0]).toMatchObject({ text: "Custom override", time: 0, duration: 4 });
    });

    it("skips a scene the user excluded from the timeline instead of blocking the render", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1" }), sceneRow({ sceneId: "s2", orderIndex: 1, excluded: true })],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome.ok).toBe(true);
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(submittedBody.source.elements).toHaveLength(1);
    });

    it("skips a scene still missing narration audio rather than blocking the whole render (per owner decision)", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1" }), sceneRow({ sceneId: "s2", orderIndex: 1, audioVersionId: null })],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome.ok).toBe(true);
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(submittedBody.source.elements).toHaveLength(1);
    });

    it("rejects when no scene has both audio and media ready yet, instead of sending Creatomate an empty video", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1", audioVersionId: null })],
        optionValues: {},
      });
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("rejects submitting a draft (not yet approved) timeline", async () => {
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId, status: "draft", templateSnapshotId, scenes: [], optionValues: {} });
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATE" });
    });

    it("VE2E-26: applies a saved Studio style override (caption font) to the submitted composition", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1" })],
        optionValues: { [DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily]: "Noto Sans" },
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome.ok).toBe(true);
      const submittedBody = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
      expect(submittedBody.source.elements[0].elements[1].font_family).toBe("Noto Sans");
    });

    it("VE2E-26: an identical resubmit after only changing the style override is not deduped as the same fingerprint (style-only change is a real new render)", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "approved",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1" })],
        optionValues: {},
      });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const first = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(first.ok).toBe(true);

      timelineRows.set(timelineVersionId, {
        ...timelineRows.get(timelineVersionId),
        optionValues: { [DYNAMIC_STYLE_OPTION_KEYS.captionFillColor]: "#ff0000" },
      });
      const second = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(second.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      if (first.ok && second.ok) expect(second.data.id).not.toBe(first.data.id);
    });
  });

  describe("VE2E-37: trimmed derivatives in the shared render step", () => {
    const timelineVersionId = "timeline-37";
    const rangedScene = (overrides: Record<string, unknown> = {}) => ({
      sceneId: "s1", orderIndex: 0, mediaAssetVersionId: "asset-1", audioVersionId: "audio-1", subtitleVersionId: null,
      screenTextOverride: "Xin chào", annotation: null, excluded: false, segmentId: "g1", sourceStartMs: 1000, sourceDurationMs: 4000, ...overrides,
    });
    const setTimeline = (scenes: unknown[], optionValues: Record<string, string> = {}) =>
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId, status: "approved", templateSnapshotId, scenes, optionValues, segments: [] });
    const okFetch = () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    };

    it("template path: keeps source audio only when the timeline explicitly set a non-zero volume for that video slot", async () => {
      okFetch();
      const cut = await withStubClipDerivatives();
      setTimeline([rangedScene()], { "Video-1.volume": "60" });
      expect((await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId })).ok).toBe(true);
      expect(cut.worker.jobs[0]!.stripAudio).toBe(false);
    });

    it("template path: a social (apify) parent is always cut without audio, even with an explicit volume", async () => {
      okFetch();
      const cut = await withStubClipDerivatives(undefined, "apify");
      setTimeline([rangedScene()], { "Video-1.volume": "60" });
      await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(cut.worker.jobs[0]!.stripAudio).toBe(true);
      expect((cut.store.rows.get("deriv-1")!.transform as any).stripAudio).toBe(true);
    });

    it("template path: only scenes that landed in a video slot are cut", async () => {
      okFetch();
      const cut = await withStubClipDerivatives();
      setTimeline([rangedScene(), rangedScene({ sceneId: "s2", orderIndex: 1, sourceStartMs: 5000 })]);
      await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(cut.worker.jobs).toHaveLength(1); // the template has a single Video-1 slot
    });

    it("template path: worker timeout fails the render with retryable MEDIA_PREPARE_FAILED - no render job, no Creatomate call, no full-source fallback", async () => {
      const fetchMock = okFetch();
      await withStubClipDerivatives(() => "silent");
      setTimeline([rangedScene()]);
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "MEDIA_PREPARE_FAILED", retryable: true });
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mediaDelivery.issueToken).not.toHaveBeenCalledWith("asset-1", expect.anything(), expect.anything(), expect.anything());
    }, 10_000);

    it("template path: a non-retryable worker error (range past the source end) is VALIDATION_FAILED", async () => {
      okFetch();
      await withStubClipDerivatives((job) => failedClipResult(job, "RANGE_OUT_OF_BOUNDS", false));
      setTimeline([rangedScene()]);
      expect(await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("template path: preflight (render account) fails before any clip is cut", async () => {
      const cut = await withStubClipDerivatives();
      templates.usableAccount = vi.fn(async () => ({ ok: false as const, code: "PROVIDER_NOT_CONFIGURED" as const, message: "x", status: 503 }));
      setTimeline([rangedScene()]);
      expect((await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId })).ok).toBe(false);
      expect(cut.worker.jobs).toHaveLength(0);
    });

    it("a ranged timeline without the derivative service wired fails closed (never sends the full source)", async () => {
      const fetchMock = okFetch();
      setTimeline([rangedScene()]);
      const outcome = await service.submitFromTimelineVersion(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe("dynamic path", () => {
      beforeEach(() => {
        prisma.templateSnapshot.findUnique = async ({ where }: any) => (where.id === templateSnapshotId ? { ...snapshotRow, rawTemplate: null } : null);
      });

      it("sends the audio-stripped derivative for a ranged scene and logs bytes before/after", async () => {
        const fetchMock = okFetch();
        const cut = await withStubClipDerivatives();
        setTimeline([rangedScene(), rangedScene({ sceneId: "s2", orderIndex: 1, sourceStartMs: null, sourceDurationMs: null, segmentId: null })]);
        const outcome = await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId });
        expect(outcome.ok).toBe(true);
        const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
        const sources = JSON.stringify(body.source);
        expect(sources).toContain("media-delivery/deriv-1");
        expect(sources).toContain("media-delivery/asset-1"); // the range-less scene still sends its source unchanged
        expect(cut.worker.jobs).toHaveLength(1);
        expect(cut.worker.jobs[0]).toMatchObject({ stripAudio: true, startMs: 1000, durationMs: 4000 });
        expect(cut.logs.join("\n")).toMatch(/47\.68MB -> 1\.91MB/);
      });

      it("worker failure fails the dynamic render too, without creating a render job", async () => {
        const fetchMock = okFetch();
        await withStubClipDerivatives((job) => failedClipResult(job, "FFMPEG_FAILED", true));
        setTimeline([rangedScene()]);
        expect(await service.submitDynamicFromTimeline(projectId, timelineVersionId, "user-1", "staff", { providerAccountId })).toMatchObject({ ok: false, code: "MEDIA_PREPARE_FAILED", retryable: true });
        expect(prisma.renderJob.create).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("the read-only preview never enqueues a cut job and keeps the source asset", async () => {
        const cut = await withStubClipDerivatives();
        setTimeline([rangedScene()]);
        const preview = await service.previewDynamicComposition(projectId, timelineVersionId, "user-1", "staff");
        expect(preview.ok && preview.data.ready).toBe(true);
        expect(cut.worker.jobs).toHaveLength(0);
        expect(JSON.stringify(preview.ok && preview.data.source)).toContain("media-delivery/asset-1");
      });
    });
  });

  describe("previewDynamicComposition (VE2E-13)", () => {
    const timelineVersionId = "timeline-preview-1";
    const sceneRow = (overrides: Record<string, unknown>) => ({
      sceneId: "s1",
      orderIndex: 0,
      mediaAssetVersionId: "asset-1",
      audioVersionId: "audio-1",
      subtitleVersionId: null,
      screenTextOverride: "Xin chào",
      annotation: null,
      excluded: false,
      ...overrides,
    });

    beforeEach(() => {
      prisma.templateSnapshot.findUnique = async ({ where }: any) => (where.id === templateSnapshotId ? { ...snapshotRow, rawTemplate: null } : null);
    });

    it("returns the same source JSON a submit would send, without calling Creatomate or creating a render job", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "draft",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1" })],
        optionValues: {},
      });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await service.previewDynamicComposition(projectId, timelineVersionId, "user-1", "staff");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.data.ready).toBe(true);
      expect(outcome.data.renderableSceneCount).toBe(1);
      expect(outcome.data.source).toMatchObject({ width: 1080, height: 1920 });
      expect((outcome.data.source as any).elements[0].elements[1].text).toBe("Xin chào");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prisma.renderJob.create).not.toHaveBeenCalled();
    });

    it("works on a draft (not yet approved) timeline, unlike submitDynamicFromTimeline", async () => {
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId, status: "draft", templateSnapshotId, scenes: [sceneRow({ sceneId: "s1" })], optionValues: {} });
      const outcome = await service.previewDynamicComposition(projectId, timelineVersionId, "user-1", "staff");
      expect(outcome).toMatchObject({ ok: true, data: { ready: true } });
    });

    it("VE2E-26: reflects the same saved Studio style override the preview would show, identical to what a submit would send", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "draft",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1" })],
        optionValues: { [DYNAMIC_STYLE_OPTION_KEYS.captionFontFamily]: "Noto Sans", [DYNAMIC_STYLE_OPTION_KEYS.imageAnimation]: "none" },
      });
      const outcome = await service.previewDynamicComposition(projectId, timelineVersionId, "user-1", "staff");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const source = outcome.data.source as any;
      expect(source.elements[0].elements[1].font_family).toBe("Noto Sans");
      expect(source.elements[0].elements[0].animations).toBeUndefined();
    });

    it("reports ready:false with a reason instead of an error when no scene is renderable yet", async () => {
      timelineRows.set(timelineVersionId, {
        id: timelineVersionId,
        projectId,
        status: "draft",
        templateSnapshotId,
        scenes: [sceneRow({ sceneId: "s1", audioVersionId: null })],
        optionValues: {},
      });
      const outcome = await service.previewDynamicComposition(projectId, timelineVersionId, "user-1", "staff");
      expect(outcome).toMatchObject({ ok: true, data: { ready: false, source: null, renderableSceneCount: 0 } });
      if (outcome.ok) expect(outcome.data.missingReason).toBeTruthy();
    });

    it("returns NOT_FOUND for a timeline version belonging to a different project", async () => {
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId: "other-project", status: "draft", templateSnapshotId, scenes: [], optionValues: {} });
      const outcome = await service.previewDynamicComposition(projectId, timelineVersionId, "user-1", "staff");
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("hides a timeline outside the caller's project grants as not-found", async () => {
      grants = { forUser: async () => ({ projectIds: [] }) };
      service = new RenderJobsService(prisma, grants, templates as CreatomateTemplatesService, mediaDelivery as MediaDeliveryService);
      timelineRows.set(timelineVersionId, { id: timelineVersionId, projectId, status: "draft", templateSnapshotId, scenes: [sceneRow({ sceneId: "s1" })], optionValues: {} });
      const outcome = await service.previewDynamicComposition(projectId, timelineVersionId, "user-1", "staff");
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });
});
