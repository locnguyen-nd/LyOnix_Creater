import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunnerService, asAccountRef, asRenderRef, asVoiceRef } from "./workflow-runner.service.js";
import type { AudioVersionsService } from "./audio-versions.service.js";
import type { PexelsService } from "./pexels.service.js";
import type { RenderJobsService } from "./render-jobs.service.js";
import type { ScriptGenerationService } from "./script-generation.service.js";
import type { ScriptVersionsService } from "./script-versions.service.js";
import type { SourcesService } from "./sources.service.js";
import type { TimelineVersionsService } from "./timeline-versions.service.js";
import { buildRenderAssignmentsFromTimeline } from "./timeline-render-mapping.js";
import { MediaPlanService } from "./media-plan.service.js";
import { ProviderLimiter } from "@lyonix/providers";

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
    expect(asRenderRef({ providerAccountId: "a", templateSnapshotId: "s1", orshot: { format: "webm", junk: 1 } })).toEqual({ providerAccountId: "a", templateSnapshotId: "s1", orshot: { format: "webm" } });
    // an invalid / empty Orshot block is dropped, never forwarded
    expect(asRenderRef({ providerAccountId: "a", templateSnapshotId: "s1", orshot: { fps: 25 } })).toEqual({ providerAccountId: "a", templateSnapshotId: "s1" });
    expect(asRenderRef({ providerAccountId: "a", templateSnapshotId: "s1", orshot: {} })).toEqual({ providerAccountId: "a", templateSnapshotId: "s1" });
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
  let timelines: Partial<TimelineVersionsService>;
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
      // Retry idempotency check (workflow-runner.service.ts): no prior "current" audio for this
      // scene id by default, so the normal generate-a-fresh-voice path below is still exercised.
      audioVersion: { findFirst: vi.fn(async () => null) },
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
        upsert: vi.fn(async ({ create, update }: any) => {
          const existing = stepRuns.find((s) => s.workflowRunId === create.workflowRunId && s.stepKey === create.stepKey && s.attempt === create.attempt);
          if (existing) return Object.assign(existing, update);
          const id = `step-${stepRuns.length + 1}`;
          const row = { id, ...create };
          stepRuns.push(row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          const key = where.workflowRunId_stepKey_attempt;
          return stepRuns.find((s) => s.workflowRunId === key.workflowRunId && s.stepKey === key.stepKey && s.attempt === key.attempt) ?? null;
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
      // Retry idempotency check: no already-approved script for this source by default, so the
      // normal generate→persist→approve path below is still exercised.
      getApprovedForSource: vi.fn(async () => ({ ok: true as const, data: null })),
      create: vi.fn(async () => ({ ok: true as const, data: draftScript as any })),
      approve: vi.fn(async () => ({ ok: true as const, data: approvedScript as any })),
    };
    audioVersions = {
      generateForWorkflowRun: vi.fn(async (sceneDraftVersionId: string) => ({ ok: true as const, data: { id: `audio-${sceneDraftVersionId}`, mediaAssetVersionId: `audio-asset-${sceneDraftVersionId}`, subtitleVersion: { id: `subtitle-${sceneDraftVersionId}` } } as any })),
    };
    pexels = {
      autoImportForScene: vi.fn(async (_projectId: string, _userId: string, _role: string, input: any) => ({ ok: true as const, data: { asset: { id: `pexels-${input.sceneId}`, kind: "video" } as any, externalId: `ext-${input.sceneId}` } })),
    };
    timelines = {
      persistApprovedForWorkflowRun: vi.fn(async () => ({ ok: true as const, data: { id: "timeline-1", status: "approved" } as any })),
    };
    renderJobs = {
      submit: vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "queued" } as any })),
      enqueueTimelineRender: vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "preparing_clips" } as any })),
      reconcileOne: vi.fn(async () => ({ ok: true as const, data: { id: "render-job-1", status: "queued" } as any })),
    };
    service = new WorkflowRunnerService(
      prisma,
      sources as SourcesService,
      scriptGeneration as ScriptGenerationService,
      scriptVersions as ScriptVersionsService,
      audioVersions as AudioVersionsService,
      new MediaPlanService(prisma, { forUser: async () => ({ teamIds: [], projectIds: [], channelIds: [] }) } as never, pexels as PexelsService),
      renderJobs as RenderJobsService,
      timelines as TimelineVersionsService,
    );
  });

  const persistedTimeline = () => (timelines.persistApprovedForWorkflowRun as ReturnType<typeof vi.fn>).mock.calls[0]![4];
  /** What the shared timeline->render mapping (the step submitFromTimelineVersion runs) produces from the persisted timeline, given every bound media is a video and audio ids resolve 1:1. */
  const renderedFromPersisted = (slots: unknown[] = templateSlots) => {
    const input = persistedTimeline();
    const resolved = input.scenes.map((scene: any, index: number) => ({
      ...scene,
      orderIndex: index,
      annotation: null,
      excluded: false,
      subtitleVersionId: scene.subtitleVersionId ?? null,
      audioVersionId: scene.audioVersionId ?? null,
      mediaKind: scene.mediaAssetVersionId ? "video" : null,
      audioMediaAssetVersionId: null,
      fallbackScreenText: null,
    }));
    return buildRenderAssignmentsFromTimeline(slots as any, resolved, input.optionValues ?? {}).assignments;
  };

  it("runs the full Auto DAG (source→script→voice→media→timeline→render) to render_queued", async () => {
    const processed = await service.processNext();
    expect(processed).toBe(true);
    expect(scriptGeneration.generate).toHaveBeenCalledWith("source-1", userId, "staff", expect.objectContaining({ providerAccountId: "content-acc", language: "vi" }));
    expect(scriptVersions.create).toHaveBeenCalledOnce();
    expect(scriptVersions.approve).toHaveBeenCalledWith("draft-1", userId, "staff");
    expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledTimes(2);
    expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledWith("scene-db-1", userId, "staff", { providerAccountId: "voice-acc", voiceId: "voice-1" });
    expect(pexels.autoImportForScene).toHaveBeenCalledTimes(2);
    // VE2E-42: Auto persists its bindings as an auto-approved TimelineVersion tagged with the run,
    // then renders from that timeline through the shared path (never raw assignments any more).
    expect(timelines.persistApprovedForWorkflowRun).toHaveBeenCalledWith("run-1", projectId, userId, "staff", {
      templateSnapshotId,
      scenes: [
        // VE2E-31: no visualPlan -> deterministic fallback; profile 30s -> range 2-3 -> one segment per scene here.
        // The mocked Pexels asset has no durationMs, so no ranges (bound exactly as before).
        { sceneId: "scene-1", mediaAssetVersionId: "pexels-scene-1", audioVersionId: "audio-scene-db-1", subtitleVersionId: "subtitle-scene-db-1", screenTextOverride: "Narration 1", segmentId: "seg-1", sourceStartMs: null, sourceDurationMs: null },
        { sceneId: "scene-2", mediaAssetVersionId: "pexels-scene-2", audioVersionId: "audio-scene-db-2", subtitleVersionId: "subtitle-scene-db-2", screenTextOverride: "Narration 2", segmentId: "seg-2", sourceStartMs: null, sourceDurationMs: null },
      ],
      segments: [
        { segmentId: "seg-1", sceneIds: ["scene-1"], mediaAssetVersionId: "pexels-scene-1", subject: null, priority: null },
        { segmentId: "seg-2", sceneIds: ["scene-2"], mediaAssetVersionId: "pexels-scene-2", subject: null, priority: null },
      ],
      optionValues: {},
    });
    expect(renderJobs.submit).not.toHaveBeenCalled();
    expect(renderJobs.enqueueTimelineRender).toHaveBeenCalledWith(projectId, "timeline-1", userId, "staff", { providerAccountId: "render-acc", idempotencyKey: "fp-1" }, "template", "run-1");
    // The rendered caption is the scene narration, not its separately-authored screenText -
    // guarantees the on-screen text matches word-for-word what the voice actually says.
    expect(renderedFromPersisted()).toEqual([
      { modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "pexels-scene-1" },
      { modificationKey: "Text-1.text", kind: "text", text: "Narration 1" },
      { modificationKey: "Video-2.source", kind: "video", mediaAssetVersionId: "pexels-scene-2" },
    ]);
    const stepKeys = stepRuns.map((s) => s.stepKey);
    expect(stepKeys.indexOf("persist_timeline_version")).toBeGreaterThan(-1);
    expect(stepKeys.indexOf("persist_timeline_version")).toBeLessThan(stepKeys.indexOf("submit_render"));
    expect(runs[0]).toMatchObject({ status: "render_queued" });
  });

  describe("VE2E-50: Japanese keywords for Apify", () => {
    const jaScript = { ...approvedScript, language: "ja", scenes: scenes.map((scene, i) => ({ ...scene, narration: i === 0 ? "新宿の夜景を紹介します。" : "渋谷のスクランブル交差点です。", visualQuery: i === 0 ? "Flashy news intro, breaking news graphic" : "Boxing ring center, empty ring" })) };
    let apify: { findAccountForUser: ReturnType<typeof vi.fn>; autoImportForSegment: ReturnType<typeof vi.fn> };
    const build = () => {
      apify = {
        findAccountForUser: vi.fn(async () => ({ id: "apify-acc", encryptedSecret: "enc" })),
        autoImportForSegment: vi.fn(async (_p: string, _u: string, _r: string, _a: unknown, input: any) => ({
          ok: true as const,
          data: { asset: { id: `apify-${input.sceneId}`, kind: "video", durationMs: 30_000 } as any, externalId: input.sceneId, ledgerId: `apify:tiktok:${input.sceneId}`, platform: "tiktok" as const, provenance: null },
        })),
      };
      scriptVersions.getApprovedForSource = vi.fn(async () => ({ ok: true as const, data: jaScript as any }));
      (scriptGeneration as any).extractSegmentKeywords = vi.fn(async () => ({
        ok: true as const,
        keywords: { "seg-1": { ja: "新宿 夜景", en: "shinjuku night" }, "seg-2": { ja: "渋谷 スクランブル交差点", en: "shibuya crossing" } },
        rejectedSegmentIds: [],
        usage: { inputTokens: 300, outputTokens: 40, costAmount: null, costCurrency: null, providerRequestId: null },
        modelId: "gpt-x",
        provider: "openai",
        promptTemplateVersion: "segment-keywords.v1",
      }));
      service = new WorkflowRunnerService(
        prisma,
        sources as SourcesService,
        scriptGeneration as ScriptGenerationService,
        scriptVersions as ScriptVersionsService,
        audioVersions as AudioVersionsService,
        new MediaPlanService(prisma, { forUser: async () => ({ teamIds: [], projectIds: [], channelIds: [] }) } as never, pexels as PexelsService, apify as never),
        renderJobs as RenderJobsService,
        timelines as TimelineVersionsService,
      );
    };

    it("no visualPlan: one extraction call from the narration feeds Apify; the English visualQuery never reaches Apify", async () => {
      build();
      await service.processNext();
      const extraction = (scriptGeneration as any).extractSegmentKeywords as ReturnType<typeof vi.fn>;
      expect(extraction).toHaveBeenCalledTimes(1);
      expect(extraction.mock.calls[0]![2].segments).toEqual([
        { segmentId: "seg-1", narration: "新宿の夜景を紹介します。" },
        { segmentId: "seg-2", narration: "渋谷のスクランブル交差点です。" },
      ]);
      expect(apify.autoImportForSegment.mock.calls.map((call) => call[4].keyword)).toEqual(["新宿 夜景", "渋谷 スクランブル交差点"]);
      // the search query handed to the Actor is only the keyword (the brief is used locally for ranking/moderation)
      expect(apify.autoImportForSegment.mock.calls.every((call) => !/Flashy|Boxing/.test(call[4].keyword))).toBe(true);
      expect(pexels.autoImportForScene).not.toHaveBeenCalled();
      // cost/usage bookkeeping like other content calls: a StepRun + ProviderOperation, and an entry in the run usage ledger
      expect(stepRuns.some((row) => row.stepKey === "extract_keywords")).toBe(true);
      const usage = stepRuns.find((row) => row.stepKey === "run_usage");
      expect(usage.outputRef.entries).toEqual([expect.objectContaining({ step: "extract_keywords", kind: "content", inputTokens: 300, outputTokens: 40 })]);
    });

    it("extraction failure: Pexels with reason no_ja_keywords, Apify never searched, run still completes", async () => {
      build();
      (scriptGeneration as any).extractSegmentKeywords = vi.fn(async () => ({ ok: false as const, code: "PROVIDER_TIMEOUT", message: "timeout" }));
      await service.processNext();
      expect(apify.autoImportForSegment).not.toHaveBeenCalled();
      expect(pexels.autoImportForScene).toHaveBeenCalledTimes(2);
      const diagnostics = stepRuns.find((row) => row.stepKey === "media_plan_diagnostics");
      expect(diagnostics.outputRef.segments.map((segment: any) => segment.fallbackReason)).toEqual(["no_ja_keywords", "no_ja_keywords"]);
      expect(stepRuns.find((row) => row.stepKey === "keyword_extraction_diagnostics").outputRef).toMatchObject({ reason: "no_ja_keywords", extracted: [] });
    });

    it("no Apify account: no extraction call is paid", async () => {
      build();
      apify.findAccountForUser.mockResolvedValue(null);
      await service.processNext();
      expect((scriptGeneration as any).extractSegmentKeywords).not.toHaveBeenCalled();
    });
  });

  it("VE2E-54: passes a narration budget to the script call and flags duration_out_of_band with the real total", async () => {
    audioVersions.generateForWorkflowRun = vi.fn(async (id: string) => ({ ok: true as const, data: { id: `audio-${id}`, mediaAssetVersionId: `audio-asset-${id}`, durationMs: id === "scene-db-1" ? 4200 : 3100, subtitleVersion: null } as any }));
    await service.processNext();
    const input = (scriptGeneration.generate as any).mock.calls[0][3];
    expect(input.durationBudget).toMatchObject({ targetSec: expect.any(Number), targetChars: expect.any(Number) });
    const diag = stepRuns.find((s) => s.stepKey === "duration_budget");
    expect(diag.outputRef).toMatchObject({ totalSec: 7.3, sceneCount: 2, inBand: false, flag: "duration_out_of_band", calibrationSource: "default" });
    expect(runs[0]).toMatchObject({ status: "render_queued" });
  });

  it("VE2E-54: an in-band total carries no flag", async () => {
    audioVersions.generateForWorkflowRun = vi.fn(async (id: string) => ({ ok: true as const, data: { id: `audio-${id}`, mediaAssetVersionId: `audio-asset-${id}`, durationMs: 15000, subtitleVersion: null } as any }));
    await service.processNext();
    const diag = stepRuns.find((s) => s.stepKey === "duration_budget");
    expect(diag.outputRef).toMatchObject({ totalSec: 30, inBand: true, flag: null });
  });

  it("VE2E-42: title/caption fill leftover template text slots through the timeline optionValues, same as the old raw-assignment path", async () => {
    const slotsWithTitle = [...templateSlots, { key: "Title.text", kind: "text", label: "Title.text", required: true }, { key: "Caption.text", kind: "text", label: "Caption.text", required: false }];
    prisma.templateSnapshot.findUnique = vi.fn(async () => ({ id: templateSnapshotId, providerAccountId: "render-acc", modifications: slotsWithTitle }));
    await service.processNext();
    // Text-1 takes scene-1 narration, Title takes scene-2 narration, Caption takes the script title
    // - exactly the positional rule of buildAutoRenderAssignments.
    expect(persistedTimeline().optionValues).toEqual({ "Caption.text": "Tiêu đề" });
    expect(renderedFromPersisted(slotsWithTitle)).toEqual([
      { modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "pexels-scene-1" },
      { modificationKey: "Text-1.text", kind: "text", text: "Narration 1" },
      { modificationKey: "Video-2.source", kind: "video", mediaAssetVersionId: "pexels-scene-2" },
      { modificationKey: "Title.text", kind: "text", text: "Narration 2" },
      { modificationKey: "Caption.text", kind: "text", text: "Tiêu đề" },
    ]);
    expect(runs[0]).toMatchObject({ status: "render_queued" });
  });

  it("VE2E-42: a timeline persistence failure is classified like any other step failure and never submits a render", async () => {
    timelines.persistApprovedForWorkflowRun = vi.fn(async () => ({ ok: false as const, code: "VALIDATION_FAILED" as const, message: "bad timeline" }));
    await service.processNext();
    expect(runs[0]).toMatchObject({ status: "needs_input", lastError: { code: "VALIDATION_FAILED", message: "bad timeline" } });
    expect(renderJobs.enqueueTimelineRender).not.toHaveBeenCalled();
  });

  it("VE2E-38/40: asks the content provider for the run's background segment range (legacy run -> auto by target duration)", async () => {
    await service.processNext();
    // profile durationSec 30 -> "<= 30s" auto rule
    expect(scriptGeneration.generate).toHaveBeenCalledWith("source-1", userId, "staff", expect.objectContaining({ backgroundSegmentRange: { min: 2, max: 3 } }));
  });

  it("VE2E-38/40: a run with a fixed intake count asks for exactly that many segments", async () => {
    runs = [draftRun({ backgroundSegments: { mode: "fixed", count: 4 } })];
    await service.processNext();
    expect(scriptGeneration.generate).toHaveBeenCalledWith("source-1", userId, "staff", expect.objectContaining({ backgroundSegmentRange: { min: 4, max: 4 } }));
  });

  it("VE2E-38: Pexels query uses the segment keywords.en when the approved script has a visualPlan, visualQuery otherwise", async () => {
    const visualPlan = {
      segments: [
        { segmentId: "g1", sceneIds: ["scene-1"], subject: "stadium", priority: 1, keywords: { ja: "スタジアム", en: "packed football stadium at night" }, styleHints: { setting: "stadium", timeOfDay: "night", lighting: "floodlights", palette: "green" } },
        { segmentId: "g2", sceneIds: ["scene-2"], subject: "crowd", priority: 2, keywords: { ja: "観客", en: "" }, styleHints: { setting: "stadium", timeOfDay: "night", lighting: "floodlights", palette: "green" } },
      ],
    };
    (scriptVersions.getApprovedForSource as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { ...approvedScript, visualPlan } });
    await service.processNext();
    const queries = (pexels.autoImportForScene as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[3].query);
    expect(queries).toEqual(["packed football stadium at night", "stadium"]);
  });

  describe("VE2E-31 one-shot background media plan", () => {
    const style = { setting: "stadium", timeOfDay: "night", lighting: "floodlights", palette: "green" };
    const withDuration = (durationMs: number) =>
      vi.fn(async (_p: string, _u: string, _r: string, input: any) => ({ ok: true as const, data: { asset: { id: `pexels-${input.sceneId}`, kind: "video", durationMs } as any, externalId: `ext-${input.sceneId}` } }));

    it("one visualPlan segment over both scenes -> ONE source, contiguous ranges by voice duration, segment kept on the timeline", async () => {
      const visualPlan = { segments: [{ segmentId: "g1", sceneIds: ["scene-1", "scene-2"], subject: "Messi", priority: 1, keywords: { ja: "メッシ", en: "soccer star dribbling" }, styleHints: style }] };
      (scriptVersions.getApprovedForSource as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: { ...approvedScript, visualPlan } });
      audioVersions.generateForWorkflowRun = vi.fn(async (id: string) => ({ ok: true as const, data: { id: `audio-${id}`, mediaAssetVersionId: `audio-asset-${id}`, durationMs: id === "scene-db-1" ? 4200 : 3100, subtitleVersion: null } as any }));
      pexels.autoImportForScene = withDuration(20_000);
      // fixed 1 segment so the plan's single segment fits the range as-is
      runs = [draftRun({ backgroundSegments: { mode: "fixed", count: 1 } })];
      await service.processNext();
      expect(pexels.autoImportForScene).toHaveBeenCalledTimes(1);
      const call = (pexels.autoImportForScene as ReturnType<typeof vi.fn>).mock.calls[0]![3];
      expect(call.sceneBrief.phrases[0]).toBe("soccer star dribbling");
      expect(call.sceneBrief.targetDurationSeconds).toBeCloseTo(7.3);
      expect(call.usedExternalIds).toEqual([]);
      const persisted = persistedTimeline();
      expect(persisted.scenes.map((s: any) => [s.mediaAssetVersionId, s.segmentId, s.sourceStartMs, s.sourceDurationMs])).toEqual([
        ["pexels-scene-1", "g1", 0, 4200],
        ["pexels-scene-1", "g1", 4200, 3100],
      ]);
      expect(persisted.segments).toEqual([{ segmentId: "g1", sceneIds: ["scene-1", "scene-2"], mediaAssetVersionId: "pexels-scene-1", subject: "Messi", priority: 1 }]);
      expect(stepRuns.map((s) => s.stepKey)).toContain("import_media_g1");
      // VE2E-48: per-segment sourceProvider + fallbackReason are persisted on the run (StepRun outputRef).
      const diagnosticsStep = stepRuns.find((s) => s.stepKey === "media_plan_diagnostics");
      expect(diagnosticsStep.outputRef.segments).toMatchObject([{ segmentId: "g1", sourcing: "imported", sourceProvider: "pexels" }]);
      expect(runs[0]).toMatchObject({ status: "render_queued" });
    });

    it("a new segment never reuses an earlier segment's source (replaces the per-scene hard block)", async () => {
      pexels.autoImportForScene = withDuration(20_000);
      await service.processNext();
      const calls = (pexels.autoImportForScene as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3]);
      expect(calls.map((c) => c.usedExternalIds)).toEqual([[], ["ext-scene-1"]]);
    });

    it("stops as needs_input when a segment cannot be sourced (unattended Auto), nothing persisted", async () => {
      pexels.autoImportForScene = vi.fn(async () => ({ ok: false as const, code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" as const, message: "weak" }));
      await service.processNext();
      expect(runs[0]).toMatchObject({ status: "needs_input", lastError: { code: "MEDIA_RELEVANCE_BELOW_THRESHOLD" } });
      expect(timelines.persistApprovedForWorkflowRun).not.toHaveBeenCalled();
    });
  });

  it("reuses an existing project-library asset for a scene instead of calling Pexels", async () => {
    mediaAssets.push({ projectId, sceneId: "scene-1", id: "library-asset-1", kind: "video", createdAt: new Date() });
    await service.processNext();
    expect(pexels.autoImportForScene).toHaveBeenCalledTimes(1);
    expect(pexels.autoImportForScene).toHaveBeenCalledWith(projectId, userId, "staff", expect.objectContaining({ sceneId: "scene-2" }));
    expect(persistedTimeline().scenes[0]).toMatchObject({ sceneId: "scene-1", mediaAssetVersionId: "library-asset-1" });
    expect(renderedFromPersisted()).toContainEqual({ modificationKey: "Video-1.source", kind: "video", mediaAssetVersionId: "library-asset-1" });
  });

  it("retry: reuses an already-approved script instead of generating a new one (stable sceneIds so media/voice idempotency below still works)", async () => {
    (scriptVersions.getApprovedForSource as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: approvedScript });
    await service.processNext();
    expect(scriptGeneration.generate).not.toHaveBeenCalled();
    expect(scriptVersions.create).not.toHaveBeenCalled();
    expect(scriptVersions.approve).not.toHaveBeenCalled();
    expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledTimes(2);
    expect(runs[0]).toMatchObject({ status: "render_queued" });
  });

  it("retry: reuses an existing current AudioVersion for a scene instead of calling ElevenLabs again", async () => {
    prisma.audioVersion.findFirst = vi.fn(async ({ where }: any) =>
      where.sceneDraftVersionId === "scene-db-1" ? { id: "audio-reused", sceneDraftVersionId: "scene-db-1", status: "current", mediaAssetVersionId: "audio-asset-reused", subtitleVersions: [{ id: "subtitle-reused" }] } : null,
    );
    await service.processNext();
    expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledTimes(1);
    expect(persistedTimeline().scenes[0]).toMatchObject({ audioVersionId: "audio-reused", subtitleVersionId: "subtitle-reused" });
    expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledWith("scene-db-2", userId, "staff", { providerAccountId: "voice-acc", voiceId: "voice-1" });
    expect(runs[0]).toMatchObject({ status: "render_queued" });
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
    expect(renderJobs.enqueueTimelineRender).not.toHaveBeenCalled();
    expect(timelines.persistApprovedForWorkflowRun).not.toHaveBeenCalled();
  });

  it("sources each scene as the kind its template slot expects (image slot -> photo, video slot -> video) and never mixes kinds in one segment", async () => {
    prisma.templateSnapshot.findUnique = vi.fn(async () => ({
      id: templateSnapshotId,
      providerAccountId: "render-acc",
      modifications: [
        { key: "Image-1.source", kind: "image", label: "Image-1.source", required: false },
        { key: "Video-2.source", kind: "video", label: "Video-2.source", required: false },
      ],
    }));
    await service.processNext();
    const calls = (pexels.autoImportForScene as any).mock.calls as Array<[string, string, string, { sceneId: string; mediaType?: string }]>;
    expect(calls.map((call) => [call[3].sceneId, call[3].mediaType])).toEqual([["scene-1", "image"], ["scene-2", "video"]]);
  });

  it("only sends a headline option to internal recipes that declare the headline slot", async () => {
    prisma.templateSnapshot.findUnique = vi.fn(async () => ({
      id: templateSnapshotId, providerAccountId: "render-acc", engine: "lyonix",
      modifications: [{ key: "badge", kind: "text", label: "Badge", required: false }],
    }));
    await service.processNext();
    expect(timelines.persistApprovedForWorkflowRun).toHaveBeenCalledWith(
      "run-1", projectId, userId, "staff", expect.objectContaining({ optionValues: {} }),
    );
    expect(runs[0]).toMatchObject({ status: "render_queued" });
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

  describe("VE2E-61 concurrency", () => {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const persistedTimelineScenes = () => persistedTimeline().scenes.map((scene: any) => scene.audioVersionId);
    const gatedVoice = () => {
      const gates: Array<() => void> = [];
      const state = { active: 0, peak: 0, started: [] as string[] };
      audioVersions.generateForWorkflowRun = vi.fn(async (id: string) => {
        state.started.push(id);
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        await new Promise<void>((resolve) => gates.push(resolve));
        state.active -= 1;
        return { ok: true as const, data: { id: `audio-${id}`, mediaAssetVersionId: `audio-asset-${id}`, durationMs: 4000, subtitleVersion: { id: `subtitle-${id}` } } as any };
      });
      const releaseAll = async () => {
        for (let i = 0; i < 20; i += 1) {
          while (gates.length) gates.shift()!();
          await tick();
        }
      };
      return { state, releaseAll };
    };

    it("voices independent scenes in parallel (bounded by voiceParallelism) and keeps scene order in the timeline", async () => {
      service.voiceParallelism = 2;
      service.limiter = new ProviderLimiter({ defaultMaxInFlight: 8 });
      const { state, releaseAll } = gatedVoice();
      const started = await service.startNextDraft();
      expect(started).not.toBeNull();
      for (let i = 0; i < 10; i += 1) await tick();
      expect(state.started).toEqual(["scene-db-1", "scene-db-2"]);
      expect(state.peak).toBe(2);
      await releaseAll();
      await (started as { done: Promise<void> }).done;
      expect(runs[0]).toMatchObject({ status: "render_queued" });
      expect(persistedTimelineScenes()).toEqual(["audio-scene-db-1", "audio-scene-db-2"]);
    });

    it("the elevenlabs limiter caps in-flight voice calls below the in-run parallelism", async () => {
      service.voiceParallelism = 4;
      service.limiter = new ProviderLimiter({ limits: { elevenlabs: 1 }, defaultMaxInFlight: 8 });
      const { state, releaseAll } = gatedVoice();
      const started = await service.startNextDraft();
      for (let i = 0; i < 10; i += 1) await tick();
      expect(state.started).toEqual(["scene-db-1"]);
      await releaseAll();
      await (started as { done: Promise<void> }).done;
      expect(state.peak).toBe(1);
      expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledTimes(2);
      expect(runs[0]).toMatchObject({ status: "render_queued" });
    });

    it("a voice failure stops new scenes and keeps the failure code (bounded retry, not a failed run)", async () => {
      service.voiceParallelism = 1;
      audioVersions.generateForWorkflowRun = vi.fn(async (id: string) =>
        id === "scene-db-1"
          ? { ok: false as const, code: "PROVIDER_RATE_LIMITED" as const, message: "429" }
          : { ok: true as const, data: { id: `audio-${id}`, mediaAssetVersionId: `m-${id}`, subtitleVersion: null } as any },
      );
      await service.processNext();
      expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledTimes(1);
      expect(runs[0]).toMatchObject({ status: "draft", attempts: 2, lastError: { code: "PROVIDER_RATE_LIMITED", retryable: true } });
    });

    it("a limiter wait timeout is a retryable PROVIDER_RATE_LIMITED, not a failed run", async () => {
      const limiter = new ProviderLimiter({ limits: { content: 1 }, waitTimeoutMs: 20 });
      service.limiter = limiter;
      let release!: () => void;
      const holder = limiter.run("content", () => new Promise<void>((resolve) => { release = resolve; }));
      await tick();
      await service.processNext();
      expect(runs[0]).toMatchObject({ status: "draft", attempts: 2, lastError: { code: "PROVIDER_RATE_LIMITED", retryable: true } });
      expect(scriptGeneration.generate).not.toHaveBeenCalled();
      release();
      await holder;
    });

    it("N concurrent runs: shared content limiter bounds script calls, slots bound runs, every run completes", async () => {
      runs.length = 0;
      for (const n of [1, 2, 3, 4]) runs.push(draftRun({ id: `run-${n}`, requestFingerprint: `fp-${n}`, correlationId: `corr-${n}`, createdAt: new Date(1_000 + n) }));
      service.limiter = new ProviderLimiter({ limits: { content: 2 }, defaultMaxInFlight: 8 });
      let active = 0;
      let peak = 0;
      const generate = scriptGeneration.generate as ReturnType<typeof vi.fn>;
      const base = generate.getMockImplementation()!;
      generate.mockImplementation(async (...args: unknown[]) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return base(...args);
      });
      const inflight = new Set<Promise<void>>();
      expect(await service.fillSlots(inflight, 3)).toBe(3);
      expect(inflight.size).toBe(3);
      expect(runs.filter((r) => r.status === "draft").map((r) => r.id)).toEqual(["run-4"]);
      while (inflight.size > 0) await Promise.race([...inflight]);
      expect(await service.fillSlots(inflight, 3)).toBe(1);
      while (inflight.size > 0) await Promise.race([...inflight]);
      expect(runs.map((r) => r.status)).toEqual(["render_queued", "render_queued", "render_queued", "render_queued"]);
      expect(peak).toBeLessThanOrEqual(2);
      expect(generate).toHaveBeenCalledTimes(4);
      expect(renderJobs.enqueueTimelineRender).toHaveBeenCalledTimes(4);
    });

    it("never double-claims: two workers racing for the same draft produce one started run and one lost race", async () => {
      const results = await Promise.all([service.startNextDraft(), service.startNextDraft()]);
      expect(results.filter((r) => r === "lost_race")).toHaveLength(1);
      const handles = results.filter((r): r is { done: Promise<void> } => typeof r === "object" && r !== null);
      expect(handles).toHaveLength(1);
      await handles[0]!.done;
      expect(scriptGeneration.generate).toHaveBeenCalledTimes(1);
      expect(audioVersions.generateForWorkflowRun).toHaveBeenCalledTimes(2);
    });

    it("returns null when nothing is queued", async () => {
      runs.length = 0;
      expect(await service.startNextDraft()).toBeNull();
      expect(await service.fillSlots(new Set(), 3)).toBe(0);
    });
  });
});
