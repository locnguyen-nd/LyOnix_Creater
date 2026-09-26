import { beforeEach, describe, expect, it } from "vitest";
import { JobsService, isSwitchableProviderError, noticeAfterApprove, noticeAfterGenerate, noticeSuggestSwitch, splitTopicSource } from "./jobs.service.js";

describe("script workflow notices", () => {
  it("emits an approve notice that leaves scripting", () => {
    expect(noticeAfterApprove(3)).toContain("v3");
    expect(noticeAfterApprove(3)).toContain("cảnh");
  });

  it("names the content provider in the generate notice", () => {
    expect(noticeAfterGenerate("openai", "gpt-4o-mini", 2, "req_1")).toContain("openai");
    expect(noticeAfterGenerate("openai", "gpt-4o-mini", 2, "req_1")).toContain("v2");
    expect(noticeAfterGenerate("openai", "gpt-4o-mini", 2, "req_1")).toContain("req_1");
  });

  it("asks the user to switch content account after quota or rate-limit", () => {
    expect(isSwitchableProviderError("PROVIDER_RATE_LIMITED")).toBe(true);
    expect(isSwitchableProviderError("PROVIDER_QUOTA_EXHAUSTED")).toBe(true);
    expect(isSwitchableProviderError("PROVIDER_SCHEMA_INVALID")).toBe(false);
    expect(noticeSuggestSwitch("openai", "gpt-5", "PROVIDER_RATE_LIMITED: no credits")).toContain("Đổi tài khoản");
  });

  it("keeps a short topic and moves a long transcript to source", () => {
    const long = "A ".repeat(200);
    const split = splitTopicSource(long);
    expect(split.topic.length).toBeLessThanOrEqual(80);
    expect(split.source.length).toBeGreaterThan(200);
  });
});

// VE2E-18: job list/detail must resolve the job's real production step (script/media/
// voice/timeline/render/done) instead of stopping at the legacy handoff_workspace_ready
// "done" - see CR-JOBS-PIPELINE-STATUS-2026-09-26 and pipeline/state.json.
describe("pipeline step resolution (VE2E-18)", () => {
  const jobId = "job-1";
  const userId = "owner-1";

  const makeRow = (overrides: Partial<{ id: string; status: string; currentStep: string }> = {}) => ({
    id: overrides.id ?? jobId,
    ownerUserId: userId,
    topic: "Lionel Messi",
    locale: "vi",
    status: overrides.status ?? "handoff_workspace_ready",
    updatedAt: new Date(),
    scripts: [
      {
        version: 1,
        approvedAt: new Date(),
        content: {
          meta: {
            code: "JOB-1001",
            mode: "topic",
            channelId: "channel-1",
            promptSpec: "",
            contentProviderAccountId: "account-1",
            model: "gpt-5",
            currentStep: overrides.currentStep ?? "done",
            promptTemplateVersion: "script-prompt.v2",
            schemaVersion: "script-draft.v1",
            providerConfigVersion: 1,
            events: [],
          },
          script: { title: "Messi", hook: "h", body: "b", cta: "c", caption: "#messi", scenes: [], version: 1 },
        },
      },
    ],
    handoffs: [],
  });

  let bridgeRows: Array<{ productionRequestId: string; projectId: string; sourceVersionId: string; scriptDraftVersionId: string }>;
  let renderJobRows: Array<{ id: string; projectId: string; status: string; resultUrl: string | null; renderDurationMs: number | null; costAmount: { toString(): string } | null; costCurrency: string | null; createdAt: Date }>;
  let timelineVersionRows: Array<{ projectId: string }>;
  let sceneDraftRows: Array<{ id: string; sceneId: string; scriptDraftVersionId: string }>;
  let audioVersionRows: Array<{ sceneDraftVersionId: string; status: string }>;
  let mediaAssetRows: Array<{ projectId: string; sceneId: string | null; deletedAt: Date | null }>;
  let rows: ReturnType<typeof makeRow>[];
  let service: JobsService;

  const inFilter = (value: string, filter: unknown) => (filter as { in: string[] }).in.includes(value);

  beforeEach(() => {
    bridgeRows = [];
    renderJobRows = [];
    timelineVersionRows = [];
    sceneDraftRows = [];
    audioVersionRows = [];
    mediaAssetRows = [];
    rows = [makeRow()];

    const prisma: any = {
      productionRequest: {
        findMany: async () => rows,
        findUnique: async ({ where }: any) => rows.find((row) => row.id === where.id) ?? null,
      },
      studioProjectBridge: {
        findMany: async ({ where }: any) => bridgeRows.filter((row) => inFilter(row.productionRequestId, where.productionRequestId)),
      },
      renderJob: {
        findMany: async ({ where }: any) =>
          renderJobRows.filter((row) => inFilter(row.projectId, where.projectId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      },
      timelineVersion: {
        findMany: async ({ where }: any) => timelineVersionRows.filter((row) => inFilter(row.projectId, where.projectId)),
      },
      sceneDraftVersion: {
        findMany: async ({ where }: any) => sceneDraftRows.filter((row) => inFilter(row.scriptDraftVersionId, where.scriptDraftVersionId)),
      },
      audioVersion: {
        findMany: async ({ where }: any) => audioVersionRows.filter((row) => inFilter(row.sceneDraftVersionId, where.sceneDraftVersionId) && row.status === where.status),
      },
      mediaAssetVersion: {
        findMany: async ({ where }: any) => mediaAssetRows.filter((row) => inFilter(row.projectId, where.projectId) && row.sceneId !== null && row.deletedAt === null),
      },
    };
    const grants: any = { forUser: async () => ({ teamIds: [], projectIds: [], channelIds: [] }) };
    service = new JobsService(prisma, grants);
  });

  it("keeps the legacy currentStep when the job has never opened Studio (no bridge)", async () => {
    rows = [makeRow({ currentStep: "produce" })];
    const jobs = await service.list(userId, "admin");
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.pipelineStep).toBe("produce");
    expect(job.studioProjectId).toBeNull();
    expect(job.render).toBeNull();
  });

  it("resolves to 'media' when bridged but no media, voice, timeline or render exist yet", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    sceneDraftRows.push({ id: "scene-1", sceneId: "s01", scriptDraftVersionId: "script-1" });
    const jobs = await service.list(userId, "admin");
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.pipelineStep).toBe("media");
    expect(job.studioProjectId).toBe("project-1");
  });

  it("resolves to 'voice' once media is assigned but no voice generated yet", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    sceneDraftRows.push({ id: "scene-1", sceneId: "s01", scriptDraftVersionId: "script-1" });
    mediaAssetRows.push({ projectId: "project-1", sceneId: "s01", deletedAt: null });
    const job = await service.getForDisplay(jobId, userId, "admin");
    expect(job?.pipelineStep).toBe("voice");
  });

  it("resolves to 'timeline' once media+voice exist even without a saved TimelineVersion", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    sceneDraftRows.push({ id: "scene-1", sceneId: "s01", scriptDraftVersionId: "script-1" });
    mediaAssetRows.push({ projectId: "project-1", sceneId: "s01", deletedAt: null });
    audioVersionRows.push({ sceneDraftVersionId: "scene-1", status: "current" });
    const job = await service.getForDisplay(jobId, userId, "admin");
    expect(job?.pipelineStep).toBe("timeline");
  });

  it("resolves to 'timeline' once a TimelineVersion is saved, without requiring a render yet", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    timelineVersionRows.push({ projectId: "project-1" });
    const job = await service.getForDisplay(jobId, userId, "admin");
    expect(job?.pipelineStep).toBe("timeline");
  });

  it("resolves to 'render' while a render job is in flight (not yet completed)", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    renderJobRows.push({ id: "render-1", projectId: "project-1", status: "rendering", resultUrl: null, renderDurationMs: null, costAmount: null, costCurrency: null, createdAt: new Date() });
    const job = await service.getForDisplay(jobId, userId, "admin");
    expect(job?.pipelineStep).toBe("render");
  });

  it("does NOT resolve to 'done' when Creatomate reports completed without a resultUrl", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    renderJobRows.push({ id: "render-1", projectId: "project-1", status: "completed", resultUrl: null, renderDurationMs: null, costAmount: null, costCurrency: null, createdAt: new Date() });
    const job = await service.getForDisplay(jobId, userId, "admin");
    expect(job?.pipelineStep).toBe("render");
  });

  it("resolves to 'done' only once render is completed with a resultUrl, and surfaces duration/cost", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    renderJobRows.push({
      id: "render-1",
      projectId: "project-1",
      status: "completed",
      resultUrl: "https://cdn.creatomate.com/renders/abc.mp4",
      renderDurationMs: 45000,
      costAmount: { toString: () => "0.4200" },
      costCurrency: "USD",
      createdAt: new Date(),
    });
    const job = await service.getForDisplay(jobId, userId, "admin");
    expect(job?.pipelineStep).toBe("done");
    expect(job?.render).toMatchObject({ id: "render-1", status: "completed", resultUrl: "https://cdn.creatomate.com/renders/abc.mp4", renderDurationMs: 45000, costAmount: "0.4200", costCurrency: "USD" });
  });

  it("picks the most recently created render job when a project has more than one", async () => {
    bridgeRows.push({ productionRequestId: jobId, projectId: "project-1", sourceVersionId: "source-1", scriptDraftVersionId: "script-1" });
    renderJobRows.push(
      { id: "render-old", projectId: "project-1", status: "failed", resultUrl: null, renderDurationMs: null, costAmount: null, costCurrency: null, createdAt: new Date("2026-09-25T00:00:00Z") },
      { id: "render-new", projectId: "project-1", status: "completed", resultUrl: "https://cdn.creatomate.com/renders/new.mp4", renderDurationMs: 30000, costAmount: null, costCurrency: null, createdAt: new Date("2026-09-26T00:00:00Z") },
    );
    const job = await service.getForDisplay(jobId, userId, "admin");
    expect(job?.render?.id).toBe("render-new");
    expect(job?.pipelineStep).toBe("done");
  });
});
