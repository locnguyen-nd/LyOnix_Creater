/**
 * VE2E-09: no-secret, integration-level proof that the full Auto DAG
 * (source → script → voice → media → timeline → render) is actually wired together end
 * to end through REAL service instances — not per-service mocked stand-ins like every
 * other `*.service.test.ts` in this repo uses (including `workflow-runner.service.test.ts`
 * itself, which mocks every one of `WorkflowRunnerService`'s direct dependencies). This
 * file instantiates the real `WorkflowRunnerService` wired to the real
 * `SourcesService`/`ScriptGenerationService`/`ScriptVersionsService`/`AudioVersionsService`
 * (→ real `ElevenLabsVoiceService` → real `MediaService`)/`PexelsService` (→ real
 * `MediaService`)/`RenderJobsService` (→ real `CreatomateTemplatesService`/`MediaDeliveryService`)/
 * `GrantsService`/`ProviderAccountsService` production code, backed by ONE shared
 * in-memory Prisma double (this file's own `fakePrisma()`) so a bug in how any two of
 * these real services actually pass data to each other (wrong field name, wrong id,
 * wrong shape) fails this test even though every individual service's own unit tests
 * still pass in isolation.
 *
 * Every outbound provider HTTP call (OpenAI, ElevenLabs, Pexels, Creatomate) is a local
 * stub via `vi.stubGlobal("fetch", ...)` / `vi.spyOn(safeBinaryFetch, "fetchBinarySafely")`
 * — the same "local HTTP stub in the test process" pattern every other VE2E-* provider
 * test in this repo already uses. No real network call, no runtime fake/mock provider
 * account (`isFake` is `false` on every account here — the REAL `status==="verified"`
 * code path is what's exercised, never the test-only `isFake` escape hatch), and
 * `PROVIDER_NOT_CONFIGURED` remains the only behavior when an account/secret is actually
 * absent (proven by the dedicated per-service tests already covering that branch).
 *
 * Real filesystem quarantine/promote calls (`writeQuarantineFile`/`readQuarantineFile`/
 * `promoteQuarantineFileToProjectAsset`) are NOT mocked — same as every existing
 * `media.service.test.ts`/`elevenlabs-voice.service.test.ts`/`pexels.service.test.ts` in
 * this repo, they write real (small, throwaway) files under `apps/api/data/media/`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioVersionsService } from "./audio-versions.service.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { ElevenLabsVoiceService } from "./elevenlabs-voice.service.js";
import { GrantsService } from "./grants.service.js";
import { MediaDeliveryService } from "./media-delivery.service.js";
import { MediaService } from "./media.service.js";
import { PexelsService } from "./pexels.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { RenderJobsService } from "./render-jobs.service.js";
import * as safeBinaryFetchModule from "./safe-binary-fetch.js";
import { ScriptGenerationService } from "./script-generation.service.js";
import { ScriptVersionsService } from "./script-versions.service.js";
import * as secretCrypto from "./secret-crypto.js";
import { SourcesService } from "./sources.service.js";
import { WorkflowRunnerService } from "./workflow-runner.service.js";

// --- generic in-memory Prisma double -------------------------------------------------

function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Record<string, unknown>[]).some((clause) => matchesWhere(row, clause));
    if (key === "NOT") return !matchesWhere(row, condition as Record<string, unknown>);
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const cond = condition as Record<string, unknown>;
      if ("lt" in cond) return value !== null && value !== undefined && (value as number) < (cond.lt as number);
      if ("lte" in cond) return value !== null && value !== undefined && (value as number) <= (cond.lte as number);
      if ("gt" in cond) return value !== null && value !== undefined && (value as number) > (cond.gt as number);
      if ("gte" in cond) return value !== null && value !== undefined && (value as number) >= (cond.gte as number);
      if ("in" in cond) return (cond.in as unknown[]).includes(value);
      if ("not" in cond) return value !== cond.not;
    }
    // Real Prisma defaults an unset nullable column to `null`; this in-memory double's
    // `create()` only ever sets the fields a real service's `data` object explicitly
    // passes, so a genuinely-absent optional field (e.g. `deletedAt` on a freshly created
    // row) reads back as `undefined`, not `null` - treat them as equivalent for `where: {field: null}`.
    if (condition === null) return value === null || value === undefined;
    return value === condition;
  });
}

function applyUpdate(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(data)) {
    if (raw !== null && typeof raw === "object" && !(raw instanceof Date) && ("increment" in raw || "decrement" in raw)) {
      const delta = "increment" in (raw as Record<string, number>) ? (raw as Record<string, number>).increment! : -(raw as Record<string, number>).decrement!;
      row[key] = ((row[key] as number) ?? 0) + delta;
    } else {
      row[key] = raw;
    }
  }
}

function sortRows<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
  if (!orderBy) return rows;
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const entry of entries as Record<string, "asc" | "desc">[]) {
      const [key, dir] = Object.entries(entry)[0] as [string, "asc" | "desc"];
      const av = a[key] as never;
      const bv = b[key] as never;
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function pick<T extends Record<string, unknown>>(row: T, select: Record<string, boolean>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(select)) out[key as keyof T] = row[key as keyof T];
  return out;
}

/** One in-memory "table" matching the small subset of Prisma model-client shape every real service here actually calls. */
function table<T extends Record<string, unknown>>(rows: T[], prefix: string) {
  let seq = 0;
  return {
    rows,
    findFirst: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
      const matched = sortRows(rows.filter((r) => matchesWhere(r, where)), orderBy);
      return matched[0] ?? null;
    },
    findMany: async ({ where, orderBy, select }: { where?: Record<string, unknown>; orderBy?: unknown; select?: Record<string, boolean> } = {}) => {
      const matched = sortRows(rows.filter((r) => matchesWhere(r, where)), orderBy);
      return select ? matched.map((r) => pick(r, select)) : matched;
    },
    findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${prefix}-${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data } as unknown as T;
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`${prefix} not found: ${where.id}`);
      applyUpdate(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      const matched = rows.filter((r) => matchesWhere(r, where));
      for (const row of matched) applyUpdate(row, data);
      return { count: matched.length };
    },
  };
}

function buildFakePrisma() {
  const users: Record<string, unknown>[] = [];
  const providerAccounts: Record<string, unknown>[] = [];
  const projects: Record<string, unknown>[] = [];
  const sourceVersions: Record<string, unknown>[] = [];
  const scriptDraftVersions: Record<string, unknown>[] = [];
  const sceneDraftVersions: Record<string, unknown>[] = [];
  const audioVersions: Record<string, unknown>[] = [];
  const subtitleVersions: Record<string, unknown>[] = [];
  const mediaAssetVersions: Record<string, unknown>[] = [];
  const mediaDeliveryTokens: Record<string, unknown>[] = [];
  const templateSnapshots: Record<string, unknown>[] = [];
  const renderJobs: Record<string, unknown>[] = [];
  const workflowRuns: Record<string, unknown>[] = [];
  const stepRuns: Record<string, unknown>[] = [];
  const providerOperations: Record<string, unknown>[] = [];
  const automationProfileVersions: Record<string, unknown>[] = [];
  const channelConnections: Record<string, unknown>[] = [];
  const teams: Record<string, unknown>[] = [];

  const withScenes = (row: Record<string, unknown>) => ({ ...row, scenes: sceneDraftVersions.filter((s) => s.scriptDraftVersionId === row.id) });
  let scriptSeq = 0;
  let sceneSeq = 0;
  let stepSeq = 0;

  const prisma: Record<string, unknown> = {
    user: table(users, "user"),
    providerAccount: table(providerAccounts, "account"),
    project: table(projects, "project"),
    sourceVersion: table(sourceVersions, "source"),
    audioVersion: table(audioVersions, "audio"),
    subtitleVersion: table(subtitleVersions, "subtitle"),
    mediaAssetVersion: table(mediaAssetVersions, "media"),
    mediaDeliveryToken: table(mediaDeliveryTokens, "token"),
    templateSnapshot: table(templateSnapshots, "snap"),
    renderJob: table(renderJobs, "render"),
    automationProfileVersion: table(automationProfileVersions, "profile"),
    channelConnection: table(channelConnections, "channel"),
    team: table(teams, "team"),
    providerOperation: table(providerOperations, "op"),
    workflowRun: table(workflowRuns, "run"),
    scriptDraftVersion: {
      findFirst: async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown }) => {
        const matched = sortRows(scriptDraftVersions.filter((r) => matchesWhere(r, where)), orderBy);
        return matched[0] ? withScenes(matched[0]) : null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = scriptDraftVersions.find((r) => r.id === where.id);
        return row ? withScenes(row) : null;
      },
      create: async ({ data }: { data: Record<string, unknown> & { scenes?: { create: Record<string, unknown>[] } } }) => {
        const { scenes, ...rest } = data;
        const id = `script-${++scriptSeq}`;
        const row = { id, createdAt: new Date(), approvedAt: null, ...rest };
        scriptDraftVersions.push(row);
        for (const scene of scenes?.create ?? []) sceneDraftVersions.push({ id: `scene-${++sceneSeq}`, scriptDraftVersionId: id, ...scene });
        return withScenes(row);
      },
      updateMany: async ({ where, data }: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matched = scriptDraftVersions.filter((r) => matchesWhere(r, where));
        for (const row of matched) applyUpdate(row, data);
        return { count: matched.length };
      },
    },
    sceneDraftVersion: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const scene = sceneDraftVersions.find((r) => r.id === where.id);
        if (!scene) return null;
        const script = scriptDraftVersions.find((r) => r.id === scene.scriptDraftVersionId);
        const source = script ? sourceVersions.find((r) => r.id === script.sourceVersionId) : null;
        return { ...scene, scriptDraftVersion: script ? { ...script, sourceVersion: source ?? null } : null };
      },
    },
    stepRun: {
      upsert: async ({ where, create, update }: { where: { workflowRunId_stepKey_attempt: { workflowRunId: string; stepKey: string; attempt: number } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const key = where.workflowRunId_stepKey_attempt;
        const existing = stepRuns.find((r) => r.workflowRunId === key.workflowRunId && r.stepKey === key.stepKey && r.attempt === key.attempt);
        if (existing) {
          applyUpdate(existing, update);
          return existing;
        }
        const row = { id: `step-${++stepSeq}`, ...create };
        stepRuns.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = stepRuns.find((r) => r.id === where.id);
        if (!row) throw new Error(`stepRun not found: ${where.id}`);
        applyUpdate(row, data);
        return row;
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  };

  return {
    prisma,
    tables: {
      users, providerAccounts, projects, sourceVersions, scriptDraftVersions, sceneDraftVersions,
      audioVersions, subtitleVersions, mediaAssetVersions, mediaDeliveryTokens, templateSnapshots,
      renderJobs, workflowRuns, stepRuns, providerOperations, automationProfileVersions,
    },
  };
}

// --- provider HTTP fixtures -----------------------------------------------------------

const scriptDraftFixture = {
  schemaVersion: "script-draft.v2",
  language: "vi",
  title: "Messi",
  hook: "Messi la ai",
  body: "Messi la mot trong nhung cau thu bong da vi dai nhat lich su.",
  cta: "Theo doi de biet them",
  caption: "#messi #bongda",
  scenes: [
    { sceneId: "s01", narration: "Messi la mot cau thu bong da noi tieng the gioi.", screenText: "Messi", visualQuery: "soccer player training on pitch", durationHintMs: 16_000 },
    { sceneId: "s02", narration: "Theo doi kenh de xem them nhieu video khac.", screenText: "Theo doi ngay", visualQuery: "call to action subscribe animation", durationHintMs: 16_000 },
  ],
};

/** ID3-tagged fixture so `validateGeneratedAudio`/`sniffMediaMimeType` sniff it as real `audio/mpeg` (same convention as `elevenlabs-voice.service.test.ts`). */
const mp3Fixture = () => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 0)]);

const alignmentFixture = {
  characters: ["h", "i"],
  character_start_times_seconds: [0, 0.1],
  character_end_times_seconds: [0.1, 0.25],
};

const pexelsVideoRow = (externalId: string) => ({
  id: Number(externalId),
  width: 1080,
  height: 1920,
  duration: 8,
  url: `https://www.pexels.com/video/some-video-${externalId}/`,
  user: { name: "Studio X", url: "https://www.pexels.com/@studio-x" },
  video_pictures: [{ picture: `https://images.pexels.com/videos/${externalId}/thumb.jpg` }],
  video_files: [{ quality: "hd", width: 1080, height: 1920, file_type: "video/mp4", link: `https://videos.pexels.com/video-files/${externalId}/${externalId}-hd.mp4` }],
});

describe("VE2E-09: Auto DAG end-to-end through real service wiring (local HTTP stubs only)", () => {
  const projectId = "project-e2e";
  const userId = "user-e2e";
  let fake: ReturnType<typeof buildFakePrisma>;
  let previousBaseUrl: string | undefined;
  let unexpectedFetchCalls: string[];
  let fetchCalls: { url: string; method: string; body: string | undefined }[];
  let pexelsSceneSeq: number;
  let pexelsVideosById: Record<string, ReturnType<typeof pexelsVideoRow>>;

  let runner: WorkflowRunnerService;

  beforeEach(() => {
    previousBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://api.lyonix.test";

    fake = buildFakePrisma();
    unexpectedFetchCalls = [];
    fetchCalls = [];
    pexelsSceneSeq = 0;
    pexelsVideosById = {};

    vi.spyOn(secretCrypto, "decryptSecret").mockImplementation((value: string) => value);
    vi.spyOn(safeBinaryFetchModule, "fetchBinarySafely").mockImplementation(async (url: string) => ({
      ok: true,
      // Content varies by URL (which itself encodes the scene-specific Pexels externalId) so
      // each scene's imported video gets a genuinely distinct checksum - reusing identical
      // bytes across scenes would make MediaService's real reusable-asset dedupe collapse
      // both scenes onto the same MediaAssetVersion row, hiding a real per-scene wiring bug.
      buffer: Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"), Buffer.from(url)]),
      mimeType: "video/mp4",
      finalUrl: url,
    }));

    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? String(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "https://api.openai.com/v1/responses" && method === "POST") {
        return new Response(JSON.stringify({ output_text: JSON.stringify(scriptDraftFixture) }), { status: 200 });
      }
      if (url.startsWith("https://api.elevenlabs.io/v1/text-to-speech/") && url.endsWith("/with-timestamps")) {
        return new Response(JSON.stringify({ audio_base64: mp3Fixture().toString("base64"), alignment: alignmentFixture }), { status: 200 });
      }
      if (url.startsWith("https://api.pexels.com/videos/search")) {
        pexelsSceneSeq += 1;
        const externalId = String(900 + pexelsSceneSeq);
        pexelsVideosById[externalId] = pexelsVideoRow(externalId);
        return new Response(JSON.stringify({ videos: [pexelsVideosById[externalId]] }), { status: 200 });
      }
      const videoDetailMatch = /^https:\/\/api\.pexels\.com\/videos\/videos\/(\d+)$/.exec(url);
      if (videoDetailMatch) {
        const row = pexelsVideosById[videoDetailMatch[1]!];
        if (row) return new Response(JSON.stringify(row), { status: 200 });
      }
      if (url === "https://api.creatomate.com/v2/renders" && method === "POST") {
        return new Response(JSON.stringify([{ id: "rnd_e2e_1", status: "planned" }]), { status: 200 });
      }
      if (url === "https://api.creatomate.com/v2/renders/rnd_e2e_1" && method === "GET") {
        return new Response(JSON.stringify({ id: "rnd_e2e_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_e2e_1.mp4", render_duration: 12.5 }), { status: 200 });
      }
      unexpectedFetchCalls.push(`${method} ${url}`);
      return new Response(JSON.stringify({ error: "unexpected call in VE2E-09 integration test" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // --- seed fixture rows -------------------------------------------------------------
    fake.tables.users.push({ id: userId, role: "admin" });
    fake.tables.projects.push({ id: projectId });
    fake.tables.sourceVersions.push({
      id: "source-e2e", projectId, type: "topic", version: 1, fetchStatus: "extracted",
      extractedText: "Lionel Messi, a legendary football player.", rawText: null, originRef: null,
      checksumSha256: null, createdByUserId: userId, createdAt: new Date(), approvedAt: null,
    });
    fake.tables.providerAccounts.push(
      { id: "content-acc-e2e", role: "content", provider: "openai", scope: "organization", ownerUserId: null, status: "verified", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini"], modelSnapshot: [], encryptedSecret: "openai-test-key", configVersion: 1, isFake: false, deletedAt: null, activeContentRequests: 0, cooldownUntil: null, version: 1 },
      { id: "tts-acc-e2e", role: "tts", provider: "elevenlabs", scope: "organization", ownerUserId: null, status: "verified", model: "eleven_multilingual_v2", availableModels: ["eleven_multilingual_v2"], encryptedSecret: "elevenlabs-test-key", isFake: false, deletedAt: null, version: 1 },
      { id: "visual-acc-e2e", role: "visual", provider: "pexels", scope: "organization", ownerUserId: null, status: "verified", model: "", encryptedSecret: "pexels-test-key", isFake: false, deletedAt: null, version: 1 },
      { id: "render-acc-e2e", role: "render", provider: "creatomate", scope: "organization", ownerUserId: null, status: "verified", model: "", encryptedSecret: "creatomate-test-key", isFake: false, deletedAt: null, version: 1 },
    );
    fake.tables.templateSnapshots.push({
      id: "snap-e2e", providerAccountId: "render-acc-e2e", externalTemplateId: "tpl_e2e", name: "E2E Template", previewUrl: null,
      modifications: [
        { key: "Video-1.source", kind: "video", label: "Video-1.source", required: true },
        { key: "Video-2.source", kind: "video", label: "Video-2.source", required: true },
        { key: "Text-1.text", kind: "text", label: "Text-1.text", required: false },
      ],
      rawTemplate: null, capturedAt: new Date(), createdByUserId: userId,
    });
    fake.tables.automationProfileVersions.push({
      id: "profile-e2e", projectId, version: 1, locale: "vi", durationSec: 32, sceneCount: 2,
      contentConfig: { providerAccountId: "content-acc-e2e" },
      voiceConfig: { providerAccountId: "tts-acc-e2e", voiceId: "voice-e2e" },
      mediaConfig: { providerAccountId: "visual-acc-e2e" },
      renderConfig: { providerAccountId: "render-acc-e2e", templateSnapshotId: "snap-e2e", outputFormat: "mp4" },
      retryPolicy: {},
    });
    fake.tables.workflowRuns.push({
      id: "run-e2e", projectId, mode: "auto", automationProfileVersionId: "profile-e2e", sourceVersionId: "source-e2e",
      status: "draft", requestFingerprint: "fp-e2e-1", correlationId: "corr-e2e-1", attempts: 1, lastError: null,
      createdByUserId: userId, createdAt: new Date(), updatedAt: new Date(),
    });

    // --- wire the REAL service graph, one shared fake prisma ---------------------------
    const grants = new GrantsService(fake.prisma as never);
    const media = new MediaService(fake.prisma as never, grants);
    const elevenLabs = new ElevenLabsVoiceService(fake.prisma as never, media);
    const sources = new SourcesService(fake.prisma as never, grants);
    const providerAccounts = new ProviderAccountsService(fake.prisma as never);
    const scriptGeneration = new ScriptGenerationService(sources, providerAccounts);
    const scriptVersions = new ScriptVersionsService(fake.prisma as never, grants);
    const audioVersions = new AudioVersionsService(fake.prisma as never, grants, elevenLabs);
    const pexels = new PexelsService(fake.prisma as never, grants, media);
    const templates = new CreatomateTemplatesService(fake.prisma as never);
    const mediaDelivery = new MediaDeliveryService(fake.prisma as never, grants);
    const renderJobsService = new RenderJobsService(fake.prisma as never, grants, templates, mediaDelivery);

    runner = new WorkflowRunnerService(fake.prisma as never, sources, scriptGeneration, scriptVersions, audioVersions, pexels, renderJobsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBaseUrl;
  });

  it("runs one Auto WorkflowRun through real source→script→voice→media→timeline→render wiring to a completed RenderJob, with a full StepRun/ProviderOperation trail", async () => {
    const processed = await runner.processNext();
    expect(processed).toBe(true);

    // No unrouted/unexpected provider call slipped through - every real HTTP call this run
    // made was one of the 4 explicitly-stubbed providers, nothing silently hit the network
    // and nothing silently fell back to a fake/placeholder path.
    expect(unexpectedFetchCalls).toEqual([]);

    const run = fake.tables.workflowRuns[0]!;
    expect(run.status).toBe("completed");
    expect(run.lastError).toBeNull();

    // --- StepRun trail (spec §3: "mọi step có input/output version refs và correlation ID") ---
    const stepKeys = fake.tables.stepRuns.map((s) => s.stepKey);
    expect(stepKeys).toEqual(
      expect.arrayContaining([
        "generate_script",
        "persist_script_version",
        "approve_script_version",
        "generate_audio_s01",
        "generate_audio_s02",
        "import_media_s01",
        "import_media_s02",
        "submit_render",
      ]),
    );
    expect(fake.tables.stepRuns.every((s) => s.status === "succeeded")).toBe(true);
    // Exactly one generate_audio_<sceneId> StepRun per real persisted scene (2), proving the
    // per-scene loop actually ran against the script version's own real generated scene ids,
    // not a hardcoded count.
    expect(stepKeys.filter((k) => (k as string).startsWith("generate_audio_")).length).toBe(2);

    // --- ProviderOperation trail: exactly one per real provider call this DAG made -------
    expect(fake.tables.providerOperations).toHaveLength(6); // content(1) + tts(2) + visual(2) + render(1)
    expect(fake.tables.providerOperations.every((o) => o.status === "succeeded")).toBe(true);
    expect(fake.tables.providerOperations.every((o) => o.correlationId === "corr-e2e-1")).toBe(true);
    expect(fake.tables.providerOperations.filter((o) => o.role === "content")).toHaveLength(1);
    expect(fake.tables.providerOperations.filter((o) => o.role === "tts")).toHaveLength(2);
    expect(fake.tables.providerOperations.filter((o) => o.role === "visual")).toHaveLength(2);
    expect(fake.tables.providerOperations.filter((o) => o.role === "render")).toHaveLength(1);

    // --- persisted domain rows actually created by real services, not asserted by proxy --
    expect(fake.tables.scriptDraftVersions).toHaveLength(1);
    expect(fake.tables.scriptDraftVersions[0]).toMatchObject({ status: "approved" });
    expect(fake.tables.sceneDraftVersions).toHaveLength(2);
    expect(fake.tables.audioVersions).toHaveLength(2);
    expect(fake.tables.audioVersions.every((a) => a.status === "current")).toBe(true);
    expect(fake.tables.subtitleVersions).toHaveLength(2);
    expect(fake.tables.mediaAssetVersions.filter((m) => m.kind === "video")).toHaveLength(2);
    expect(fake.tables.mediaAssetVersions.filter((m) => m.kind === "audio")).toHaveLength(2);
    // Two distinct scenes must resolve to two distinct imported video assets, never the same
    // one twice (would indicate the per-scene sceneId wiring collapsed to a single scene).
    const videoAssetIds = new Set(fake.tables.mediaAssetVersions.filter((m) => m.kind === "video").map((m) => m.id));
    expect(videoAssetIds.size).toBe(2);

    // --- the render job actually completed with a real (stubbed) result URL --------------
    expect(fake.tables.renderJobs).toHaveLength(1);
    const job = fake.tables.renderJobs[0]!;
    expect(job.status).toBe("completed");
    expect(job.resultUrl).toBe("https://cdn.creatomate.com/rnd_e2e_1.mp4");
    expect(job.renderDurationMs).toBe(12_500);
    expect(job.workflowRunId).toBe("run-e2e");

    // --- the actual Creatomate submit payload used the real generated script text and the
    // real per-scene signed media-delivery URLs (proves the whole chain's data, not just
    // status flags, actually flowed end to end) --------------------------------------------
    const submitCall = fetchCalls.find((c) => c.url === "https://api.creatomate.com/v2/renders" && c.method === "POST");
    expect(submitCall).toBeTruthy();
    const submittedBody = JSON.parse(submitCall!.body!) as { modifications: Record<string, string> };
    expect(submittedBody.modifications["Video-1.source"]).toContain("/media-delivery/");
    expect(submittedBody.modifications["Video-2.source"]).toContain("/media-delivery/");
    expect(submittedBody.modifications["Text-1.text"]).toBe("Messi");
  });

  it("fails closed to blocked_provider through the real wiring when the content account is not verified - zero provider calls, never a runtime fake fallback", async () => {
    const contentAccount = fake.tables.providerAccounts.find((a) => a.id === "content-acc-e2e")!;
    contentAccount.status = "failed";

    const processed = await runner.processNext();
    expect(processed).toBe(true);

    const run = fake.tables.workflowRuns[0]!;
    expect(run.status).toBe("blocked_provider");
    expect(run.lastError).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });

    // No script/audio/media/render side effects were created, and no provider HTTP call was
    // ever made - the real ScriptGenerationService.generate() wiring fails before any network
    // call the same way it would for a genuinely missing/unverified live secret.
    expect(fetchCalls).toEqual([]);
    expect(unexpectedFetchCalls).toEqual([]);
    expect(fake.tables.scriptDraftVersions).toHaveLength(0);
    expect(fake.tables.mediaAssetVersions).toHaveLength(0);
    expect(fake.tables.renderJobs).toHaveLength(0);
  });
});
