import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@lyonix/db";
import { VideoProductionsService } from "./video-productions.service.js";
import type { AutomationProfilesService } from "./automation-profiles.service.js";
import type { SourcesService } from "./sources.service.js";

const projectId = "project-1";
const automationProfileId = "profile-1";
const sourceId = "source-1";
const userId = "user-1";

const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });

const completeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: automationProfileId,
  projectId,
  version: 1,
  locale: "vi",
  durationSec: 30,
  sceneCount: 4,
  contentConfig: { providerAccountId: "content-acc" },
  voiceConfig: { providerAccountId: "voice-acc", voiceId: "voice-1" },
  mediaConfig: { providerAccountId: "media-acc" },
  renderConfig: { providerAccountId: "render-acc", templateSnapshotId: "snap-1" },
  retryPolicy: {},
  ...overrides,
});

describe("VideoProductionsService", () => {
  let prisma: any;
  let grants: any;
  let sources: Partial<SourcesService>;
  let automationProfiles: Partial<AutomationProfilesService>;
  let service: VideoProductionsService;
  let workflowRuns: any[];
  let createdProjects: any[];

  beforeEach(() => {
    workflowRuns = [];
    createdProjects = [];
    prisma = {
      project: {
        findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: `project-${createdProjects.length + 1}`, ...data };
          createdProjects.push(row);
          return row;
        }),
      },
      automationProfileVersion: { findUnique: async ({ where }: any) => (where.id === automationProfileId ? completeProfile() : null) },
      sourceVersion: { findUnique: async ({ where }: any) => (where.id === sourceId ? { id: sourceId, projectId } : null) },
      scriptDraftVersion: { findFirst: async () => null },
      renderJob: { findFirst: async () => null, findMany: async () => [] as any[] },
      stepRun: { findMany: async () => [], groupBy: async () => [] as any[] },
      workflowRun: {
        create: vi.fn(async ({ data }: any) => {
          if (workflowRuns.some((row) => row.requestFingerprint === data.requestFingerprint)) throw p2002();
          const row = { id: `run-${workflowRuns.length + 1}`, attempts: 1, correlationId: "corr-1", lastError: null, createdAt: new Date(), updatedAt: new Date(), ...data };
          workflowRuns.push(row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id) return workflowRuns.find((row) => row.id === where.id) ?? null;
          if (where.requestFingerprint) return workflowRuns.find((row) => row.requestFingerprint === where.requestFingerprint) ?? null;
          return null;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const row = workflowRuns.find((item) => item.id === where.id && item.status === where.status && !item.deletedAt);
          if (!row) return { count: 0 };
          // Prisma.JsonNull is a write-time sentinel for a nullable Json column - a real
          // round-trip through Postgres reads it back as plain JS `null`, so normalize the
          // same way here rather than leaking the sentinel object into in-memory test state.
          Object.assign(row, data.lastError === Prisma.JsonNull ? { ...data, lastError: null } : data);
          return { count: 1 };
        }),
        findMany: vi.fn(async ({ where }: any) => {
          return workflowRuns
            .filter((row) => row.mode === where.mode)
            .filter((row) => (where.deletedAt === null ? !row.deletedAt : true))
            .filter((row) => (where.projectId ? row.projectId === where.projectId : true))
            .filter((row) => (where.createdByUserId ? row.createdByUserId === where.createdByUserId : true))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }),
      },
    };
    grants = { forUser: vi.fn(async () => ({ projectIds: [projectId] })), replaceProjectGrants: vi.fn(async () => undefined) };
    sources = { create: vi.fn(async () => ({ id: "source-new", projectId, type: "topic" }) as any) };
    automationProfiles = { create: vi.fn(async () => completeProfile() as any) };
    service = new VideoProductionsService(prisma, grants, sources as SourcesService, automationProfiles as AutomationProfilesService);
  });

  describe("submit", () => {
    it("rejects mode=studio (not implemented by this endpoint yet)", async () => {
      const outcome = await service.submit(userId, "staff", { mode: "studio", projectId, automationProfileId, sourceId });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    });

    it("hides an inaccessible project as not-found", async () => {
      grants.forUser.mockResolvedValue({ projectIds: [] });
      const outcome = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("rejects when both sourceId and source are given (or neither)", async () => {
      const both = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId, source: { type: "topic", topic: "x" } });
      expect(both).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      const neither = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId });
      expect(neither).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    });

    it("fails fast with PROVIDER_NOT_CONFIGURED (no row created) when the profile is missing mediaConfig/renderConfig", async () => {
      prisma.automationProfileVersion.findUnique = async () => completeProfile({ mediaConfig: null, renderConfig: null });
      const outcome = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
      expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    });

    it("fails fast when voiceConfig has no voiceId (Auto cannot generate TTS without one)", async () => {
      prisma.automationProfileVersion.findUnique = async () => completeProfile({ voiceConfig: { providerAccountId: "voice-acc" } });
      const outcome = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
    });

    it("creates a draft WorkflowRun with an existing sourceId and returns poll/events URLs", async () => {
      const outcome = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      expect(outcome).toMatchObject({ ok: true, data: { status: "draft", pollUrl: expect.stringContaining("/video-productions/"), eventsUrl: expect.stringContaining("/events") } });
      expect(prisma.workflowRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mode: "auto", sourceVersionId: sourceId, status: "draft" }) }));
    });

    it("inline-creates a source when `source` is given instead of sourceId", async () => {
      const outcome = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, source: { type: "topic", topic: "Messi" } });
      expect(outcome.ok).toBe(true);
      expect(sources.create).toHaveBeenCalledWith(projectId, userId, "staff", { type: "topic", topic: "Messi" });
      expect(prisma.workflowRun.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ sourceVersionId: "source-new" }) }));
    });

    it("returns NOT_FOUND when sourceId belongs to a different project", async () => {
      prisma.sourceVersion.findUnique = async () => ({ id: sourceId, projectId: "other-project" });
      const outcome = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("returns the existing run (idempotent) on a duplicate submit with the same fingerprint", async () => {
      const first = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      const second = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      expect(first.ok && second.ok && first.data.id === second.data.id).toBe(true);
      expect(prisma.workflowRun.create).toHaveBeenCalledTimes(2);
    });
  });

  describe("backgroundSegments (VE2E-40)", () => {
    const previousMin = process.env.BACKGROUND_SEGMENTS_MIN_COUNT;
    const previousMax = process.env.BACKGROUND_SEGMENTS_MAX_COUNT;
    const restoreEnv = () => {
      if (previousMin === undefined) delete process.env.BACKGROUND_SEGMENTS_MIN_COUNT;
      else process.env.BACKGROUND_SEGMENTS_MIN_COUNT = previousMin;
      if (previousMax === undefined) delete process.env.BACKGROUND_SEGMENTS_MAX_COUNT;
      else process.env.BACKGROUND_SEGMENTS_MAX_COUNT = previousMax;
    };

    it("persists the default auto setting when omitted and resolves it from the intake target duration", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      expect(workflowRuns[0].backgroundSegments).toEqual({ mode: "auto" });
      const run = await service.get(submitted.data.id, userId, "staff");
      // profile durationSec 30 -> "<= 30s" rule
      expect(run).toMatchObject({ ok: true, data: { backgroundSegments: { setting: { mode: "auto" }, range: { min: 2, max: 3 } } } });
    });

    it("persists a user-fixed count and exposes it as an exact range", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId, backgroundSegments: { mode: "fixed", count: 4 } });
      if (!submitted.ok) throw new Error("expected ok");
      expect(workflowRuns[0].backgroundSegments).toEqual({ mode: "fixed", count: 4 });
      expect(await service.get(submitted.data.id, userId, "staff")).toMatchObject({ ok: true, data: { backgroundSegments: { setting: { mode: "fixed", count: 4 }, range: { min: 4, max: 4 } } } });
    });

    it("rejects an out-of-range or malformed setting before creating any source/run", async () => {
      for (const bad of [{ mode: "fixed", count: 0 }, { mode: "fixed", count: 7 }, { mode: "fixed", count: 2.5 }, { mode: "other" }]) {
        const outcome = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, source: { type: "topic", topic: "x" }, backgroundSegments: bad as never });
        expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      }
      expect(sources.create).not.toHaveBeenCalled();
      expect(prisma.workflowRun.create).not.toHaveBeenCalled();
    });

    it("uses configurable bounds (BACKGROUND_SEGMENTS_MIN_COUNT/MAX_COUNT)", async () => {
      process.env.BACKGROUND_SEGMENTS_MIN_COUNT = "2";
      process.env.BACKGROUND_SEGMENTS_MAX_COUNT = "8";
      try {
        expect(await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId, backgroundSegments: { mode: "fixed", count: 1 } })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
        expect(await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId, backgroundSegments: { mode: "fixed", count: 8 } })).toMatchObject({ ok: true });
      } finally {
        restoreEnv();
      }
    });

    it("keeps the auto-submit fingerprint unchanged but distinguishes a fixed count", async () => {
      const auto = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      const explicitAuto = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId, backgroundSegments: { mode: "auto" } });
      const fixed = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId, backgroundSegments: { mode: "fixed", count: 3 } });
      if (!auto.ok || !explicitAuto.ok || !fixed.ok) throw new Error("expected ok");
      expect(explicitAuto.data.id).toBe(auto.data.id);
      expect(fixed.data.id).not.toBe(auto.data.id);
    });

    it("a retry keeps the run's persisted setting (only status/attempts/lastError are reset)", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId, backgroundSegments: { mode: "fixed", count: 5 } });
      if (!submitted.ok) throw new Error("expected ok");
      workflowRuns[0].status = "failed";
      expect(await service.retry(submitted.data.id, userId, "staff")).toMatchObject({ ok: true });
      expect(workflowRuns[0]).toMatchObject({ status: "draft", backgroundSegments: { mode: "fixed", count: 5 } });
    });

    it("reads a legacy run without the column as auto", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      delete workflowRuns[0].backgroundSegments;
      expect(await service.get(submitted.data.id, userId, "staff")).toMatchObject({ ok: true, data: { backgroundSegments: { setting: { mode: "auto" } } } });
    });
  });

  describe("get / listEvents", () => {
    it("reports the linked render job's resultUrl and the latest approved scriptDraftVersionId", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      prisma.scriptDraftVersion.findFirst = async () => ({ id: "script-1" });
      prisma.renderJob.findFirst = async () => ({ id: "render-1", resultUrl: "https://cdn.example/video.mp4" });
      const outcome = await service.get(submitted.data.id, userId, "staff");
      expect(outcome).toMatchObject({ ok: true, data: { scriptDraftVersionId: "script-1", renderJobId: "render-1", resultUrl: "https://cdn.example/video.mp4" } });
    });

    it("returns the persisted per-segment sourcing diagnostics of the latest media step (VE2E-48)", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      expect(await service.get(submitted.data.id, userId, "staff")).toMatchObject({ ok: true, data: { mediaSourcing: null } });
      const segments = [{ segmentId: "seg-1", sourcing: "imported", sourceProvider: "pexels", fallbackReason: "no_apify_account" }];
      prisma.stepRun.findMany = async () => [{ stepKey: "media_plan_diagnostics", attempt: 1, outputRef: { segments } }];
      expect(await service.get(submitted.data.id, userId, "staff")).toMatchObject({ ok: true, data: { mediaSourcing: segments } });
    });

    it("hides a run outside the caller's project grants as not-found", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      grants.forUser.mockResolvedValue({ projectIds: [] });
      expect(await service.get(submitted.data.id, userId, "staff")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await service.listEvents(submitted.data.id, userId, "staff")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("lists step events oldest-first", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      prisma.stepRun.findMany = async () => [
        { stepKey: "generate_script", status: "succeeded", attempt: 1, error: null, startedAt: new Date(), endedAt: new Date() },
      ];
      const outcome = await service.listEvents(submitted.data.id, userId, "staff");
      expect(outcome).toMatchObject({ ok: true, data: [{ stepKey: "generate_script", status: "succeeded" }] });
    });
  });

  describe("remove", () => {
    it("soft deletes only the selected completed run, retaining its project and audit rows", async () => {
      const first = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      prisma.sourceVersion.findUnique = async () => ({ id: "source-2", projectId });
      const second = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId: "source-2" });
      if (!first.ok || !second.ok) throw new Error("expected two runs");
      workflowRuns[0].status = "completed";
      workflowRuns[1].status = "completed";
      expect(await service.remove(first.data.id, userId, "staff")).toMatchObject({ ok: true, data: { deleted: true } });
      expect(workflowRuns).toHaveLength(2);
      expect(workflowRuns[0].deletedAt).toBeInstanceOf(Date);
      expect(workflowRuns[1].deletedAt).toBeUndefined();
      const visible = await service.list(userId, "staff");
      expect(visible).toMatchObject({ ok: true, data: [{ id: second.data.id }] });
      expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: first.data.id, deletedAt: null }) }));
      expect(await service.get(first.data.id, userId, "staff")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(await service.listEvents(first.data.id, userId, "staff")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("rejects active and other-user runs", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected run");
      expect(await service.remove(submitted.data.id, userId, "staff")).toMatchObject({ ok: false, code: "INVALID_STATE", status: 409 });
      workflowRuns[0].status = "failed";
      expect(await service.remove(submitted.data.id, "other-user", "admin")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("cancelQueued (VE2E-62)", () => {
    it("takes a run that is still waiting in the queue (draft) out of it", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected run");
      expect(workflowRuns[0].status).toBe("draft");
      expect(await service.cancelQueued(submitted.data.id, userId, "staff")).toMatchObject({ ok: true, data: { cancelled: true } });
      expect(workflowRuns[0].status).toBe("cancelled");
      expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: submitted.data.id, status: "draft", deletedAt: null }) }));
    });

    it("never cancels a run a worker already claimed (compare-and-set on draft) -> 409", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected run");
      for (const status of ["source_ready", "voice_generating", "rendering", "completed", "failed"]) {
        workflowRuns[0].status = status;
        expect(await service.cancelQueued(submitted.data.id, userId, "staff")).toMatchObject({ ok: false, code: "INVALID_STATE", status: 409 });
        expect(workflowRuns[0].status).toBe(status);
      }
    });

    it("hides another user's run as not found and does not touch it", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected run");
      expect(await service.cancelQueued(submitted.data.id, "other-user", "admin")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(workflowRuns[0].status).toBe("draft");
    });
  });

  describe("retry", () => {
    it("re-queues a failed/blocked/needs_input run to draft with a fresh attempts count and clears lastError", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected run");
      workflowRuns[0].status = "needs_input";
      workflowRuns[0].attempts = 2;
      workflowRuns[0].lastError = { code: "MEDIA_RELEVANCE_UNVERIFIED", message: "no relevant media" };
      expect(await service.retry(submitted.data.id, userId, "staff")).toMatchObject({ ok: true, data: { retried: true } });
      expect(workflowRuns[0]).toMatchObject({ status: "draft", attempts: 1, lastError: null });
      expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: submitted.data.id, status: "needs_input", deletedAt: null }) }));
    });

    it("rejects a run that is not in a retriable status, a cancelled run, and another user's run", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected run");
      expect(await service.retry(submitted.data.id, userId, "staff")).toMatchObject({ ok: false, code: "INVALID_STATE", status: 409 });
      workflowRuns[0].status = "completed";
      expect(await service.retry(submitted.data.id, userId, "staff")).toMatchObject({ ok: false, code: "INVALID_STATE", status: 409 });
      workflowRuns[0].status = "cancelled";
      expect(await service.retry(submitted.data.id, userId, "staff")).toMatchObject({ ok: false, code: "INVALID_STATE", status: 409 });
      workflowRuns[0].status = "failed";
      expect(await service.retry(submitted.data.id, "other-user", "admin")).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("without projectId, returns only the caller's own runs across all of their self-provisioned projects, never another user's", async () => {
      prisma.project.findUnique = async ({ where }: any) => (where.id === projectId || where.id === "project-2" ? { id: where.id } : null);
      prisma.sourceVersion.findUnique = async ({ where }: any) => {
        if (where.id === sourceId) return { id: sourceId, projectId };
        if (where.id === "source-2") return { id: "source-2", projectId: "project-2" };
        if (where.id === "source-3") return { id: "source-3", projectId };
        return null;
      };
      prisma.automationProfileVersion.findUnique = async ({ where }: any) =>
        where.id === "profile-2" ? completeProfile({ projectId: "project-2", id: "profile-2" }) : completeProfile();

      const mine1 = await service.submit(userId, "admin", { mode: "auto", projectId, automationProfileId, sourceId });
      const mine2 = await service.submit(userId, "admin", { mode: "auto", projectId: "project-2", automationProfileId: "profile-2", sourceId: "source-2" });
      const notMine = await service.submit("other-user", "admin", { mode: "auto", projectId, automationProfileId, sourceId: "source-3" });
      if (!mine1.ok || !mine2.ok || !notMine.ok) throw new Error("expected all three submits to succeed");

      const outcome = await service.list(userId, "staff");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const ids = outcome.data.map((row) => row.id);
      expect(ids.sort()).toEqual([mine1.data.id, mine2.data.id].sort());
      expect(ids).not.toContain(notMine.data.id);
    });

    it("with projectId, scopes to that project and enforces the same read-access check as get()", async () => {
      await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      grants.forUser.mockResolvedValue({ projectIds: [] });
      expect(await service.list(userId, "staff", projectId)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("attaches the latest linked RenderJob's resultUrl/snapshotUrl/cost/duration onto each run", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      prisma.renderJob.findMany = async () => [
        { workflowRunId: submitted.data.id, resultUrl: "https://cdn.example/video.mp4", snapshotUrl: "https://cdn.example/video.jpg", costAmount: { toString: () => "0.42" }, renderDurationMs: 12345 },
      ];
      const outcome = await service.list(userId, "staff");
      expect(outcome).toMatchObject({
        ok: true,
        data: [{ id: submitted.data.id, resultUrl: "https://cdn.example/video.mp4", snapshotUrl: "https://cdn.example/video.jpg", costAmount: "0.42", renderDurationMs: 12345 }],
      });
    });

    it("VE2E-22: reports snapshotUrl:null (not undefined/missing) before any render has reported one", async () => {
      const submitted = await service.submit(userId, "staff", { mode: "auto", projectId, automationProfileId, sourceId });
      if (!submitted.ok) throw new Error("expected ok");
      const outcome = await service.list(userId, "staff");
      expect(outcome).toMatchObject({ ok: true, data: [{ id: submitted.data.id, snapshotUrl: null }] });
    });

    it("returns an empty list rather than erroring when the caller has no runs yet", async () => {
      expect(await service.list(userId, "staff")).toMatchObject({ ok: true, data: [] });
    });
  });

  // VE2E-08: one-click Auto needs a Project + AutomationProfileVersion provisioned before
  // submit() will accept a run - see the doc comment on setupAutoProfile() for why this
  // can't just be a plain POST /projects call (admin-only).
  describe("setupAutoProfile", () => {
    const validInput = {
      name: "Messi Auto",
      contentAccountId: "content-acc",
      voiceAccountId: "voice-acc",
      voiceId: "voice-1",
      mediaAccountId: "media-acc",
      renderAccountId: "render-acc",
      templateSnapshotId: "snap-1",
    };

    it("provisions a project (self-granted, not admin-gated) and a matching automation profile", async () => {
      const outcome = await service.setupAutoProfile(userId, "staff", validInput);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(createdProjects).toHaveLength(1);
      expect(outcome.data.projectId).toBe(createdProjects[0].id);
      expect(grants.replaceProjectGrants).toHaveBeenCalledWith(createdProjects[0].id, [], [userId]);
      expect(automationProfiles.create).toHaveBeenCalledWith(
        userId,
        "staff",
        expect.objectContaining({
          projectId: createdProjects[0].id,
          contentConfig: { providerAccountId: "content-acc" },
          voiceConfig: { providerAccountId: "voice-acc", voiceId: "voice-1" },
          mediaConfig: { providerAccountId: "media-acc" },
          renderConfig: { providerAccountId: "render-acc", templateSnapshotId: "snap-1" },
        }),
      );
      expect(outcome.data.automationProfileId).toBe(automationProfileId);
    });

    it("stores sanitized Orshot render options in renderConfig and drops unknown keys", async () => {
      const outcome = await service.setupAutoProfile(userId, "staff", { ...validInput, renderOptions: { format: "webm", size: "tiktok-video", apiKey: "leak" } });
      expect(outcome.ok).toBe(true);
      expect(automationProfiles.create).toHaveBeenCalledWith(userId, "staff", expect.objectContaining({ renderConfig: { providerAccountId: "render-acc", templateSnapshotId: "snap-1", orshot: { format: "webm", size: "tiktok-video" } } }));
    });

    it("rejects invalid Orshot render options before provisioning a project", async () => {
      const outcome = await service.setupAutoProfile(userId, "staff", { ...validInput, renderOptions: { fps: 25 } });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(createdProjects).toHaveLength(0);
    });

    it("rejects when any required account/voiceId/template field is missing", async () => {
      const outcome = await service.setupAutoProfile(userId, "staff", { ...validInput, voiceId: "" });
      expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
      expect(createdProjects).toHaveLength(0);
    });

    it("surfaces a forbidden automation-profile write as a failed setup, without silently succeeding", async () => {
      automationProfiles.create = vi.fn(async () => "forbidden" as const);
      const outcome = await service.setupAutoProfile(userId, "staff", validInput);
      expect(outcome).toMatchObject({ ok: false, code: "FORBIDDEN" });
    });
  });
});
