import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPlanService, SegmentSourceLedger, type MediaPlanScript } from "./media-plan.service.js";
import type { ApifyService } from "./apify.service.js";
import type { PexelsService } from "./pexels.service.js";
import { WorkflowRunnerService, personGateInput } from "./workflow-runner.service.js";

// Strict person media mode end to end (STUBS only, not evidence of live Apify / Pexels behaviour): a video about 佐々木朗希 whose only
// usable media is generic stock (Apify out of quota) must stop with PERSON_MEDIA_INSUFFICIENT instead of rendering phones and streets.
vi.mock("./quarantine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./quarantine.js")>()),
  writeQuarantineFile: vi.fn(async (buffer: Buffer) => ({ quarantineToken: "quarantine-token", sha256: "x", bytes: buffer.byteLength })),
}));

const roki = { main: "佐々木朗希", kind: "person", aliases: ["Roki Sasaki"], mustInclude: ["ドジャース", "Dodgers"], mustExclude: [], otherPeople: [] };
const narrations = ["佐々木朗希投手にまつわる衝撃のニュース", "彼の身に何が起きたのか", "訃報の噂に球界が凍りついた", "これはデマだった", "朗希は元気にマウンドへ", "応援しよう"];
const script = (): MediaPlanScript => ({
  language: "ja",
  scenes: narrations.map((narration, i) => ({ sceneId: `scene_${i + 1}`, narration, screenText: "", visualQuery: i === 3 ? "Hand holding smartphone news" : "Roki Sasaki pitching", durationHintMs: 5000, voiceDurationMs: 5000 })),
  // Gemini's free-form reply: segments broken, subject kept (subject-only plan).
  visualPlan: { segments: [], videoSubject: roki } as never,
});

function setup() {
  const apify = { findAccountForUser: vi.fn(async () => ({ id: "apify-acc", encryptedSecret: "enc" })), autoImportForSegment: vi.fn(async () => ({ ok: false, reason: "apify_error:PROVIDER_QUOTA_EXHAUSTED" })) };
  let n = 0;
  const pexels = { autoImportForScene: vi.fn(async () => ({ ok: true, data: { asset: { id: `px-${++n}`, kind: "video", durationMs: 30_000 }, externalId: `px${n}` } })) };
  const media = { registerAsset: vi.fn(async () => ({ id: "brand-bg", kind: "image" })) };
  const service = new MediaPlanService({ mediaAssetVersion: { findFirst: async () => null }, providerAccount: { findFirst: async () => null } } as never, {} as never, pexels as unknown as PexelsService, apify as unknown as ApifyService, undefined, media as never);
  return { service, apify, pexels };
}

describe("strict person media: Apify out of quota + only generic stock", () => {
  beforeEach(() => { process.env.APIFY_VIDEO_PLATFORMS = "tiktok"; process.env.MEDIA_SEGMENT_DEADLINE_MS = "3000"; });
  afterEach(() => { delete process.env.APIFY_VIDEO_PLATFORMS; delete process.env.MEDIA_SEGMENT_DEADLINE_MS; });

  it("the subject-only plan binds every segment; stock searches only the person's context; the render is blocked (PERSON_MEDIA_INSUFFICIENT)", async () => {
    const { service, apify, pexels } = setup();
    const planScript = script();
    const gate = personGateInput(planScript, "佐々木朗希の衝撃デマ騒動の真実");
    expect(gate).toMatchObject({ strict: true, target: { name: "佐々木朗希", source: "model" } });
    const segments = service.planSegments(planScript, null, { ...roki, strict: true });
    expect(segments.every((segment) => (segment.keywords as { subject?: string; personStrict?: boolean }).subject === "佐々木朗希" && (segment.keywords as { personStrict?: boolean }).personStrict)).toBe(true);

    const sourcing = await service.sourceSegments("p1", "u", "staff", { providerAccountId: "acc", script: planScript, segments, ledger: new SegmentSourceLedger(), guaranteeSource: true });
    // Every Apify tier keyword names the person; stock never searches the scene's generic visual query ("smartphone").
    const apifyKeywords = apify.autoImportForSegment.mock.calls.map((call) => ((call as unknown[])[4] as { keyword: string }).keyword);
    expect(apifyKeywords.length).toBeGreaterThan(0);
    expect(apifyKeywords.every((keyword) => /佐々木朗希|Roki Sasaki/.test(keyword))).toBe(true);
    const stockQueries = pexels.autoImportForScene.mock.calls.map((call) => ((call as unknown[])[3] as { query: string }).query);
    expect(stockQueries.every((query) => ["ドジャース", "Dodgers"].includes(query))).toBe(true);
    const diagnostics = service.buildBindings(planScript, sourcing.sourced).diagnostics;
    expect(diagnostics.every((entry) => entry.person?.mediaRole === "context" && entry.person?.strict === true)).toBe(true);

    const mediaPlan = service.buildBindings(planScript, sourcing.sourced);
    const runner = Object.create(WorkflowRunnerService.prototype) as WorkflowRunnerService & Record<string, unknown>;
    const saved: Array<{ key: string; value: unknown }> = [];
    Object.assign(runner, {
      prisma: { mediaAssetVersion: { findMany: async () => [] } },
      saveStepDiagnostics: async (_run: unknown, key: string, value: unknown) => { saved.push({ key, value }); },
    });
    const applyQualityGate = (runner as unknown as { applyQualityGate: (run: unknown, ctx: unknown) => Promise<void> }).applyQualityGate.bind(runner);
    await expect(
      applyQualityGate({ id: "run-1" }, {
        mediaPlan,
        sourced: sourcing.sourced,
        narrationByScene: new Map(planScript.scenes.map((scene) => [scene.sceneId, scene.narration])),
        durationByScene: new Map(planScript.scenes.map((scene) => [scene.sceneId, 5000])),
        targetSec: 30,
        person: gate,
      }),
    ).rejects.toMatchObject({ code: "PERSON_MEDIA_INSUFFICIENT", message: expect.stringContaining("Không đủ hình/video đúng người mục tiêu để dựng video.") });
    const gateOutput = saved.find((entry) => entry.key === "quality_gate")?.value as { personMedia?: { strict?: boolean; coverage?: { personSceneCount: number; totalScenes: number; scenes: Array<{ mediaRole: string }> } } };
    expect(gateOutput.personMedia).toMatchObject({ strict: true, coverage: { personSceneCount: 0, totalScenes: 6 } });
    expect(gateOutput.personMedia?.coverage?.scenes.every((scene) => scene.mediaRole === "context")).toBe(true);
  });

  it("not strict (STRICT_PERSON_MEDIA_MODE=0): same media renders with a clear warning instead of a block", async () => {
    process.env.STRICT_PERSON_MEDIA_MODE = "0";
    try {
      const gate = personGateInput(script(), "佐々木朗希の衝撃デマ騒動の真実");
      expect(gate?.strict).toBe(false);
    } finally {
      delete process.env.STRICT_PERSON_MEDIA_MODE;
    }
  });
});
