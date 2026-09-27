import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunnerService, asAccountRef, asRenderRef, asVoiceRef } from "./workflow-runner.service.js";
import type { AudioVersionsService } from "./audio-versions.service.js";
import type { PexelsService } from "./pexels.service.js";
import type { RenderJobsService } from "./render-jobs.service.js";
import type { ScriptGenerationService } from "./script-generation.service.js";
import type { ScriptVersionsService } from "./script-versions.service.js";
import type { SourcesService } from "./sources.service.js";

const projectId = "project-1";
const userId = "user-1";
const templateSnapshotId = "snap-1";

const scenes = [
  { id: "scene-db-1", sceneId: "scene-1", orderIndex: 0, narration: "Narration 1", screenText: "Screen 1", visualQuery: "football", durationHintMs: 5000 },
  { id: "scene-db-2", sceneId: "scene-2", orderIndex: 1, narration: "Narration 2", screenText: "Screen 2", visualQuery: "stadium", durationHintMs: 5000 },
];

const approvedScript = {
  id: "script-1",
  sourceVersionId: "source-1",
  version: 1,
  status: "approved" as const,
  language: "vi",
  title: "Tiêu đề",
  hook: "Hook",
  body: "Body",
  cta: "CTA",
  caption: "Caption",
  providerPin: { accountId: "content-acc", provider: "openai", modelId: "gpt-x", configVersion: 1, promptTemplateVersion: "v1" },
  supersedesId: null,
  createdAt: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
  scenes,
};

const draftScript = { ...approvedScript, id: "draft-1", status: "draft" as const };

const templateSlots = [
  { key: "Video-1.source", kind: "video", label: "Video-1.source", required: true },
  { key: "Video-2.source", kind: "video", label: "Video-2.source", required: true },
  { key: "Text-1.text", kind: "text", label: "Text-1.text", required: false },
];

const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: "profile-1",
  projectId,
  version: 1,
  locale: "vi",
  durationSec: 30,
  sceneCount: 2,
  contentConfig: { providerAccountId: "content-acc" },
  voiceConfig: { providerAccountId: "voice-acc", voiceId: "voice-1" },
  mediaConfig: { providerAccountId: "media-acc" },
  renderConfig: { providerAccountId: "render-acc", templateSnapshotId },
  retryPolicy: {},
  ...overrides,
});

const draftRun = (overrides: Record<string, unknown> = {}) => ({
  id: "run-1",
  projectId,
  mode: "auto" as const,
  automationProfileVersionId: "profile-1",
  sourceVersionId: "source-1",
  status: "draft" as const,
  requestFingerprint: "fp-1",
  correlationId: "corr-1",
  attempts: 1,
  lastError: null,
  createdByUserId: userId,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("asAccountRef / asVoiceRef / asRenderRef", () => {
  it("parses valid refs and rejects malformed ones", () => {
    expect(asAccountRef({ providerAccountId: "a" })).toEqual({ providerAccountId: "a" });
    expect(asAccountRef({})).toBeNull();
    expect(asAccountRef(null)).toBeNull();
    expect(asVoiceRef({ providerAccountId: "a", voiceId: "v1" })).toEqual({ providerAccountId: "a", voiceId: "v1" });
    expect(asVoiceRef({ providerAccountId: "a" })).toEqual({ providerAccountId: "a" });
    expect(asRenderRef({ providerAccountId: "a", templateSnapshotId: "s1", outputFormat: "mp4" })).toEqual({ providerAccountId: "a", templateSnapshotId: "s1", outputFormat: "mp4" });
    expect(asRenderRef({ providerAccountId: "a" })).toBeNull();
  });
});

describe("WorkflowRunnerService", () => {
  let prisma: any;
  let sources: Partial<SourcesService>;
  let scriptGeneration: Partial<ScriptGenerationService>;
  let scriptVersions: Partial<ScriptVersionsService>;
  let audioVersions: Partial<AudioVersionsService>;
  let pexels: Partial<PexelsService>;
  let renderJobs: Partial<RenderJobsService>;
  let service: WorkflowRunnerService;
  let runs: any[];
  let mediaAssets: any[];
  let stepRuns: any[];

  beforeEach(() => {
    runs = [draftRun()];
    mediaAssets = [];
    stepRuns = [];
    prisma = {
      user: { findUnique: vi.fn(async () => ({ id: userId, role: "staff" })) },
      automationProfileVersion: { findUnique: vi.fn(async ({ where }: any) => (where.id === "profile-1" ? profileRow() : null)) },
      sourceVersion: { findUnique: vi.fn(async () => ({ id: "source-1", projectId, type: "topic", fetchStatus: "extracted" })) },
      templateSnapshot: { findUnique: vi.fn(async ({ where }: any) => (where.id === templateSnapshotId ? { id: templateSnapshotId, providerAccountId: "render-acc", modifications: templateSlots } : null)) },
      mediaAssetVersion: {
        findFirst: vi.fn(async ({ where }: any) => mediaAssets.find((a) => a.projectId === where.projectId && a.sceneId === where.sceneId) ?? null),
      },
      renderJob: { findFirst: vi.fn(async () => null) },
      workflowRun: {
        findFirst: vi.fn(async ({ where }: any) => {
          if (where.status === "draft") return runs.find((r) => r.status === "draft") ?? null;
          if (where.status?.in) return null;
          return null;
        }),
        findMany: vi.fn(async ({ where }: any) => runs.filter((r) => where.status.in.includes(r.status))),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const row = runs.find((r) => r.id === where.id && r.status === where.status);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = runs.find((r) => r.id === where.id);
          const { attempts, ...rest } = data;
          Object.assign(row, rest);
          if (attempts && typeof attempts === "object" && "increment" in attempts) row.attempts += attempts.increment;
          else if (attempts !== undefined) row.attempts = attempts;
          return row;
        }),
      },
      stepRun: {
        upsert: vi.fn(async ({ create }: any) => {
          const id = `step-${stepRuns.length + 1}`;
          const row = { id, ...create };
          stepRuns.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = stepRuns.find((s) => s.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
      providerOperation: {
        create: vi.fn(async ({ data }: any) => ({ id: `op-${Math.random()}`, ...data })),
        update: vi.fn(async () => ({})),
      },
    };
    sources = { extractArticle: vi.fn() };
    scriptGeneration = { generate: vi.fn(async () => ({ ok: true as const, response: { sourceId: "source-1", draft: { schemaVersion: "script-draft.v2", language: "vi", title: "t", hook: "h", body: "b", cta: "c", caption: "cap", scenes: [] } as any, providerPin: approvedScript.providerPin } })) };
    scriptVersions = {
      create: vi.fn(async () => ({ ok: true as const, data: draftScript as any })),
      approve: vi.fn(async () => ({ ok: true as const, data: approvedScript as any })),
    };
    audioVersions = {
      generateForWorkflowRun: vi.fn(async (sceneDraftVersionId: string) => ({ ok: true as const, data: { id: `audio-${sceneDraftVersionId}`, mediaAssetVersionId: `audio-asset-${sceneDraftVersionId}` } as any })),
    };
    pexels = {
      autoImportForScene: vi.fn(async (_projectId: string, _userId: string, _role: string, input: any) => ({ ok: true as const, data: { asset: { id: `pexels-${input.sceneId}`, kind: "video" } as any, externalId: `ext-${input.sceneId}` } })),
    };
    renderJobs = {
      submit: vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "queued" } as any })),
      reconcileOne: vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "queued" } as any })),
    };
    service = new WorkflowRunnerService(
      prisma,
      sources as SourcesService,
      scriptGeneration as ScriptGenerationService,
      scriptVersions as ScriptVersionsService,
      audioVersions as AudioVersionsService,
      pexels as PexelsService,
      renderJobs as RenderJobsService,
    );
  });

  it("runs the full Auto DAG (source→script→voice→media→timeline→render) to render_queued", async () => {
    const processed = await service.processNext();
    expect(processed).toBe(true);
    expect(scriptGeneration.generate).toHaveBeenCalledWith("source-1", userId, "staff", expect.objectContaining({ providerAccountId: "content-acc", language: "vi" }));
    expect(scriptVersions.create).toHaveBeenCalledOnce();
    expect(scriptVersions.approve).toHaveBeenCalledWith("draft-1", userId, "staff");
    expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledTimes(2);
    expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledWith("scene-db-1", userId, "staff", { providerAccountId: "voice-acc", voiceId: "voice-1" });
    expect(pexels.autoImportForScene).toHaveBeenCalledTimes(2);
    expect(renderJobs.submit).toHaveBeenCalledWith(
      projectId,
      userId,
      "staff",
      expect.objectContaining({ templateSnapshotId, providerAccountId: "render-acc", idempotencyKey: "fp-1" }),
      "run-1",
    );
    const submittedAssignments = (renderJobs.submit as ReturnType<typeof vi.fn>).mock.calls[0]![3].assignments;
    expect(submittedAssignments).toEqual([
      { modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "pexels-scene-1" },
      { modificationKey: "Text-1.text", kind: "text", text: "Screen 1" },
      { modificationKey: "Video-2.source", kind: "video", mediaAssetVersionId: "pexels-scene-2" },
    ]);
    expect(runs[0]).toMatchObject({ status: "render_queued" });
  });

  it("reuses an existing project-library asset for a scene instead of calling Pexels", async () => {
    mediaAssets.push({ projectId, sceneId: "scene-1", id: "library-asset-1", kind: "video", createdAt: new Date() });
    await service.processNext();
    expect(pexels.autoImportForScene).toHaveBeenCalledTimes(1);
    expect(pexels.autoImportForScene).toHaveBeenCalledWith(projectId, userId, "staff", expect.objectContaining({ sceneId: "scene-2" }));
    const submittedAssignments = (renderJobs.submit as ReturnType<typeof vi.fn>).mock.calls[0]![3].assignments;
    expect(submittedAssignments).toContainEqual({ modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "library-asset-1" });
  });

  it("does not start when the profile is missing mediaConfig/renderConfig (blocked_provider, zero provider calls)", async () => {
    prisma.automationProfileVersion.findUnique = vi.fn(async () => profileRow({ mediaConfig: null }));
    await service.processNext();
    expect(runs[0]).toMatchObject({ status: "blocked_provider" });
    expect(runs[0].lastError).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect(scriptGeneration.generate).not.toHaveBeenCalled();
  });

  it("classifies a content provider auth failure as blocked_provider", async () => {
    scriptGeneration.generate = vi.fn(async () => ({ ok: false as const, code: "PROVIDER_AUTH_INVALID" as const, message: "bad key" }));
    await service.processNext();
    expect(runs[0]).toMatchObject({ status: "blocked_provider", lastError: { code: "PROVIDER_AUTH_INVALID", message: "bad key" } });
  });

  it("classifies a missing required render slot as needs_input (no render submitted)", async () => {
    prisma.templateSnapshot.findUnique = vi.fn(async () => ({ id: templateSnapshotId, providerAccountId: "render-acc", modifications: [{ key: "Video-1.source", kind: "video", label: "Video-1.source", required: true }, { key: "Video-2.source", kind: "video", label: "Video-2.source", required: true }, { key: "Video-3.source", kind: "video", label: "Video-3.source", required: true }] }));
    await service.processNext();
    expect(runs[0]).toMatchObject({ status: "needs_input" });
    expect(renderJobs.submit).not.toHaveBeenCalled();
  });

  it("bounded-retries a transient provider failure (re-queues to draft, increments attempts) then fails after maxAttempts", async () => {
    audioVersions.generateForWorkflowRun = vi.fn(async () => ({ ok: false as const, code: "PROVIDER_RATE_LIMITED" as const, message: "rate limited" }));
    await service.processNext();
    expect(runs[0]).toMatchObject({ status: "draft", attempts: 2 });
    await service.processNext();
    expect(runs[0]).toMatchObject({ status: "failed", attempts: 2, lastError: { code: "PROVIDER_RATE_LIMITED" } });
  });

  it("respects a profile-level retryPolicy.maxAttempts override", async () => {
    prisma.automationProfileVersion.findUnique = vi.fn(async () => profileRow({ retryPolicy: { maxAttempts: 1 } }));
    scriptGeneration.generate = vi.fn(async () => ({ ok: false as const, code: "PROVIDER_TIMEOUT" as const, message: "timed out" }));
    await service.processNext();
    expect(runs[0]).toMatchObject({ status: "failed" });
  });

  describe("reconcileRenders", () => {
    it("advances a render_queued run to completed when the linked RenderJob completes", async () => {
      runs = [draftRun({ status: "render_queued" })];
      prisma.renderJob.findFirst = vi.fn(async () => ({ id: "render-job-1" }));
      renderJobs.reconcileOne = vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "completed", resultUrl: "https://cdn/x.mp4" } as any }));
      const processed = await service.processNext();
      expect(processed).toBe(true);
      expect(runs[0]).toMatchObject({ status: "completed" });
    });

    it("marks the run failed with the render job's lastError when the render fails", async () => {
      runs = [draftRun({ status: "render_queued" })];
      prisma.renderJob.findFirst = vi.fn(async () => ({ id: "render-job-1" }));
      renderJobs.reconcileOne = vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "failed", lastError: { code: "PROVIDER_SUBMIT_UNKNOWN", message: "boom" } } as any }));
      await service.processNext();
      expect(runs[0]).toMatchObject({ status: "failed", lastError: { code: "PROVIDER_SUBMIT_UNKNOWN", message: "boom", stepKey: "render" } });
    });

    it("leaves a still-queued render job's run untouched", async () => {
      runs = [draftRun({ status: "render_queued" })];
      prisma.renderJob.findFirst = vi.fn(async () => ({ id: "render-job-1" }));
      renderJobs.reconcileOne = vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "queued" } as any }));
      const processed = await service.processNext();
      expect(processed).toBe(true);
      expect(runs[0]).toMatchObject({ status: "render_queued" });
    });

    it("returns false from processNext when there is nothing to claim or reconcile", async () => {
      runs = [];
      expect(await service.processNext()).toBe(false);
    });
  });
});
