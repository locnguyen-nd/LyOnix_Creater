import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@lyonix/db";
import { StudioBridgeService } from "./studio-bridge.service.js";
import type { JobRecord } from "./jobs.service.js";
import type { JobsService } from "./jobs.service.js";

const jobId = "job-1";
const userId = "user-1";
const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });

const approvedJob: JobRecord = {
  id: jobId,
  code: "JOB-1001",
  mode: "topic",
  topic: "Lionel Messi",
  locale: "vi",
  status: "handoff_workspace_ready",
  currentStep: "done",
  channelId: "channel-1",
  promptSpec: "",
  contentProviderAccountId: "account-1",
  model: "gpt-5",
  promptTemplateVersion: "script-prompt.v2",
  schemaVersion: "script-draft.v1",
  providerConfigVersion: 1,
  createdByUserId: userId,
  updatedAt: new Date().toISOString(),
  events: [],
  lastNotice: null,
  captionPlan: null,
  handoff: null,
  script: {
    schemaVersion: "script-draft.v1",
    language: "vi",
    title: "Messi",
    hook: "Ai la GOAT?",
    body: "Full narration",
    cta: "Theo doi",
    caption: "#messi",
    scenes: [
      { sceneId: "s01", narration: "Xin chao", screenText: "Xin chao", visualBrief: "stadium", estimatedDurationMs: 5000 },
      { sceneId: "s02", narration: "GOAT", screenText: "GOAT", visualBrief: "trophy", estimatedDurationMs: 6000 },
    ],
    version: 1,
    approvedVersion: 1,
  },
};

const draftJob: JobRecord = { ...approvedJob, script: { ...approvedJob.script, approvedVersion: null } };

describe("StudioBridgeService", () => {
  let prisma: any;
  let grants: any;
  let jobs: Partial<JobsService>;
  let service: StudioBridgeService;
  let projectRows: any[];
  let sourceRows: any[];
  let scriptRows: any[];
  let sceneRows: any[];
  let bridgeRows: any[];
  let timelineRows: any[];
  let nextId: number;
  let currentJob: JobRecord | null;

  beforeEach(() => {
    nextId = 1;
    projectRows = [];
    sourceRows = [];
    scriptRows = [];
    sceneRows = [];
    bridgeRows = [];
    timelineRows = [];
    currentJob = approvedJob;

    jobs = { get: async () => currentJob };
    prisma = {
      providerAccount: { findUnique: async () => ({ id: "account-1", provider: "openai" }) },
      project: { create: async ({ data }: any) => { const row = { id: `project-${nextId++}`, ...data }; projectRows.push(row); return row; } },
      sourceVersion: { create: async ({ data }: any) => { const row = { id: `source-${nextId++}`, ...data }; sourceRows.push(row); return row; } },
      scriptDraftVersion: {
        create: async ({ data }: any) => {
          const id = `script-${nextId++}`;
          const { scenes, ...rest } = data;
          const row = { id, ...rest };
          scriptRows.push(row);
          for (const s of scenes?.create ?? []) sceneRows.push({ id: `scene-${nextId++}`, scriptDraftVersionId: id, ...s });
          return row;
        },
      },
      sceneDraftVersion: {
        findMany: async ({ where }: any) => sceneRows.filter((r) => r.scriptDraftVersionId === where.scriptDraftVersionId).sort((a, b) => a.orderIndex - b.orderIndex),
      },
      studioProjectBridge: {
        findUnique: async ({ where }: any) => bridgeRows.find((r) => r.productionRequestId === where.productionRequestId) ?? null,
        create: async ({ data }: any) => {
          if (bridgeRows.some((r) => r.productionRequestId === data.productionRequestId)) throw p2002();
          bridgeRows.push({ createdAt: new Date(), ...data });
          return bridgeRows[bridgeRows.length - 1];
        },
      },
      timelineVersion: { findFirst: async ({ where }: any) => timelineRows.filter((r) => r.projectId === where.projectId).sort((a, b) => b.version - a.version)[0] ?? null },
    };
    grants = { replaceProjectGrants: async () => undefined };
    service = new StudioBridgeService(prisma, grants, jobs as JobsService);
  });

  it("refuses to bridge a job whose script has not been approved yet", async () => {
    currentJob = draftJob;
    const outcome = await service.ensureContext(jobId, userId, "staff");
    expect(outcome).toMatchObject({ ok: false, code: "INVALID_STATE" });
  });

  it("returns NOT_FOUND when the job does not exist or is not accessible", async () => {
    jobs.get = async () => null;
    const outcome = await service.ensureContext(jobId, userId, "staff");
    expect(outcome).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("provisions a Project/SourceVersion/ScriptDraftVersion mirroring the job's approved script on first open", async () => {
    const outcome = await service.ensureContext(jobId, userId, "staff");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.jobId).toBe(jobId);
    expect(projectRows).toHaveLength(1);
    expect(sourceRows).toHaveLength(1);
    expect(scriptRows).toHaveLength(1);
    expect(outcome.data.scenes).toHaveLength(2);
    expect(outcome.data.scenes[0]).toMatchObject({ sceneId: "s01", narration: "Xin chao" });
    expect(outcome.data.latestTimelineVersion).toBeNull();
  });

  it("is idempotent: a second call reuses the same bridged project instead of creating another", async () => {
    const first = await service.ensureContext(jobId, userId, "staff");
    const second = await service.ensureContext(jobId, userId, "staff");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.data.projectId).toBe(first.data.projectId);
    expect(projectRows).toHaveLength(1);
  });

  it("recovers from a concurrent-create race by reusing the winner's bridge row", async () => {
    const originalCreate = prisma.studioProjectBridge.create;
    let calls = 0;
    prisma.studioProjectBridge.create = async (args: any) => {
      calls += 1;
      if (calls === 1) {
        // Simulate another request winning the race just before this one commits.
        bridgeRows.push({ productionRequestId: jobId, projectId: "project-winner", sourceVersionId: "source-winner", scriptDraftVersionId: "script-winner", createdAt: new Date() });
        throw p2002();
      }
      return originalCreate(args);
    };
    const outcome = await service.ensureContext(jobId, userId, "staff");
    expect(outcome).toMatchObject({ ok: true, data: { projectId: "project-winner" } });
  });
});
