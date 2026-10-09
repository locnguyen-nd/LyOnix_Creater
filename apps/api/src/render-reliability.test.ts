import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@lyonix/providers";
import { evaluateAutoPreflight, preflightRefusal, type AutoPreflightFacts } from "./auto-preflight.js";
import { callContentWithModelFailover } from "./content-model-failover.js";
import { checkPublicBaseUrl, isLocalHost, resetPublicBaseUrlCache } from "./public-base-url.js";
import { MAX_AUTO_RETRY_WAIT_MS, MIN_RETRY_WAIT_MS, RETRY_BASE_MS, RETRY_MAX_BACKOFF_MS, planRunRetry } from "./run-retry.js";
import { earliestContentRetryAt } from "./script-generation.service.js";
import { auditCreatomate, auditLyonix, type SnapshotFacts } from "./template-audit.js";
import { HEARTBEAT_STALE_MS, readWorkerHealth, type WorkerHealth } from "./worker-health.js";

const gate = () => ({
  acquireContentRequestSlot: vi.fn(async () => true),
  releaseContentRequestSlot: vi.fn(async () => undefined),
  cooldownContentAccount: vi.fn(async () => new Date()),
  markModelUnusable: vi.fn(async () => undefined),
  markModelLimited: vi.fn(async (_a: string, _m: string, ms?: number) => new Date(Date.now() + (ms ?? 0))),
  getModelAvailability: vi.fn(async (_accountId: string, _modelId: string) => ({ available: true, retryAt: null as Date | null })),
});

const dailyQuota = () => new ProviderError("PROVIDER_QUOTA_EXHAUSTED", "Quota exceeded ... model: gemini-2.5-flash", false, 79_586_000, "daily");

describe("Gemini quota per model + fallback", () => {
  it("model A out of daily quota -> model B runs; the account is NOT cooled down", async () => {
    const accounts = gate();
    const call = vi.fn(async (model: string) => { if (model === "gemini-2.5-flash") throw dailyQuota(); return `script by ${model}`; });
    const result = await callContentWithModelFailover(accounts, "acc", ["gemini-2.5-flash", "gemini-3.5-flash"], call);
    expect(result).toMatchObject({ ok: true, value: "script by gemini-3.5-flash", modelId: "gemini-3.5-flash" });
    expect(call.mock.calls.map((args) => args[0])).toEqual(["gemini-2.5-flash", "gemini-3.5-flash"]); // one call per model, no duplicate
    expect(accounts.markModelLimited).toHaveBeenCalledWith("acc", "gemini-2.5-flash", 79_586_000, "PROVIDER_QUOTA_EXHAUSTED");
    expect(accounts.cooldownContentAccount).not.toHaveBeenCalled();
  });

  it("a quota error with no known scope benches the model only (Gemini quotas are per model)", async () => {
    const accounts = gate();
    const call = vi.fn(async (model: string) => { if (model === "a") throw new ProviderError("PROVIDER_RATE_LIMITED", "429", true, 5_000); return model; });
    await expect(callContentWithModelFailover(accounts, "acc", ["a", "b"], call)).resolves.toMatchObject({ ok: true, modelId: "b" });
    expect(accounts.cooldownContentAccount).not.toHaveBeenCalled();
  });

  it("a key-wide (billing) limit still cools the whole account and stops - other models would fail the same way", async () => {
    const accounts = gate();
    const call = vi.fn(async () => { throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", "insufficient_quota", false, undefined, "account"); });
    await expect(callContentWithModelFailover(accounts, "acc", ["a", "b"], call)).resolves.toMatchObject({ ok: false, accountBlocked: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(accounts.cooldownContentAccount).toHaveBeenCalledTimes(1);
  });

  it("a model still in cooldown is never called again; an account in cooldown makes no call at all", async () => {
    const accounts = gate();
    accounts.getModelAvailability.mockImplementation(async (_acc, model) => (model === "a" ? { available: false, retryAt: new Date(Date.now() + 60_000) } : { available: true, retryAt: null }));
    const call = vi.fn(async (model: string) => model);
    await expect(callContentWithModelFailover(accounts, "acc", ["a", "b"], call)).resolves.toMatchObject({ ok: true, modelId: "b" });
    expect(call).toHaveBeenCalledTimes(1);

    const cooled = gate();
    cooled.acquireContentRequestSlot.mockResolvedValue(false);
    const none = vi.fn();
    await expect(callContentWithModelFailover(cooled, "acc", ["a", "b"], none)).resolves.toMatchObject({ ok: false, accountBlocked: true });
    expect(none).not.toHaveBeenCalled();
  });

  it("the failed content call reports when it can run again (earliest benched model, else Retry-After)", () => {
    const now = new Date("2026-10-09T02:00:00Z");
    expect(earliestContentRetryAt([{ retryAt: new Date("2026-10-09T03:00:00Z") }, { retryAt: new Date("2026-10-09T02:30:00Z") }], null, now)).toBe("2026-10-09T02:30:00.000Z");
    expect(earliestContentRetryAt([], { retryAfterMs: 12_000 }, now)).toBe("2026-10-09T02:00:12.000Z");
    expect(earliestContentRetryAt([], null, now)).toBeUndefined();
  });
});

describe("run retry backoff", () => {
  const now = new Date("2026-10-09T02:00:00Z");

  it("waits for the provider's Retry-After / cooldown, never ~1 s", () => {
    const plan = planRunRetry({ attempt: 1, retryAfterMs: 17_000, now });
    expect(plan).toMatchObject({ retry: true, waitMs: 17_000 });
    expect(plan.retry && plan.notBefore.toISOString()).toBe("2026-10-09T02:00:17.000Z");
    expect(planRunRetry({ attempt: 1, retryAfterMs: 200, now }).waitMs).toBe(MIN_RETRY_WAIT_MS);
  });

  it("without a Retry-After: bounded exponential backoff", () => {
    expect(planRunRetry({ attempt: 1, now }).waitMs).toBe(RETRY_BASE_MS);
    expect(planRunRetry({ attempt: 2, now }).waitMs).toBe(RETRY_BASE_MS * 2);
    expect(planRunRetry({ attempt: 9, now }).waitMs).toBe(RETRY_MAX_BACKOFF_MS);
  });

  it("a wait beyond the auto-retry window (daily quota) is not waited out silently: no auto retry, retry time reported", () => {
    const plan = planRunRetry({ attempt: 1, retryAfterMs: 79_586_000, now });
    expect(plan.retry).toBe(false);
    expect(!plan.retry && plan.retryAt.toISOString()).toBe(new Date(now.getTime() + 79_586_000).toISOString());
    expect(planRunRetry({ attempt: 1, retryAfterMs: MAX_AUTO_RETRY_WAIT_MS, now }).retry).toBe(true);
  });
});

describe("PUBLIC_BASE_URL preflight", () => {
  beforeEach(() => resetPublicBaseUrlCache());
  const env = (url?: string): NodeJS.ProcessEnv => ({ NODE_ENV: "development", ...(url === undefined ? {} : { PUBLIC_BASE_URL: url }) });

  it("missing / invalid / local URLs fail without any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(checkPublicBaseUrl({ env: env(), fetchImpl: fetchImpl as never })).resolves.toMatchObject({ ok: false, problem: "NOT_CONFIGURED" });
    await expect(checkPublicBaseUrl({ env: env("not a url"), fetchImpl: fetchImpl as never })).resolves.toMatchObject({ ok: false, problem: "INVALID_URL" });
    await expect(checkPublicBaseUrl({ env: env("ftp://x.example"), fetchImpl: fetchImpl as never })).resolves.toMatchObject({ ok: false, problem: "INVALID_URL" });
    await expect(checkPublicBaseUrl({ env: env("http://localhost:3000"), fetchImpl: fetchImpl as never })).resolves.toMatchObject({ ok: false, problem: "NOT_PUBLIC" });
    await expect(checkPublicBaseUrl({ env: env("http://192.168.1.20:3000"), fetchImpl: fetchImpl as never })).resolves.toMatchObject({ ok: false, problem: "NOT_PUBLIC" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isLocalHost("10.0.0.5")).toBe(true);
    expect(isLocalHost("api.lyonix.example")).toBe(false);
  });

  it("a dead tunnel (HTTP 530) fails early with a clear reason; a live one passes (temporary tunnel = warning)", async () => {
    const dead = vi.fn(async (_url: string) => new Response("error code: 1033", { status: 530 }));
    const failed = await checkPublicBaseUrl({ env: env("https://old-tunnel.trycloudflare.com"), fetchImpl: dead as never });
    expect(failed).toMatchObject({ ok: false, problem: "UNREACHABLE", probed: true });
    expect(!failed.ok && failed.message).toContain("HTTP 530");
    expect(String(dead.mock.calls[0]?.[0])).toBe("https://old-tunnel.trycloudflare.com/api/v1/health");

    const live = vi.fn(async () => new Response(JSON.stringify({ data: { status: "ok", service: "api" } }), { status: 200 }));
    const passed = await checkPublicBaseUrl({ env: env("https://new-tunnel.trycloudflare.com/"), fetchImpl: live as never });
    expect(passed).toMatchObject({ ok: true, baseUrl: "https://new-tunnel.trycloudflare.com", probed: true });
    expect(passed.ok && passed.warning).toContain("trycloudflare");
  });

  it("a URL answering with something that is not our API is not trusted; results are cached briefly", async () => {
    const other = vi.fn(async () => new Response("<html>parked</html>", { status: 200 }));
    await expect(checkPublicBaseUrl({ env: env("https://parked.example"), fetchImpl: other as never })).resolves.toMatchObject({ ok: false, problem: "UNREACHABLE" });
    await checkPublicBaseUrl({ env: env("https://parked.example"), fetchImpl: other as never });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("tests and PUBLIC_BASE_URL_PROBE=0 skip the network probe", async () => {
    const fetchImpl = vi.fn();
    await expect(checkPublicBaseUrl({ env: { NODE_ENV: "test", PUBLIC_BASE_URL: "https://api.lyonix.local" }, fetchImpl: fetchImpl as never })).resolves.toMatchObject({ ok: true, probed: false });
    await expect(checkPublicBaseUrl({ env: { PUBLIC_BASE_URL: "https://x.example", PUBLIC_BASE_URL_PROBE: "0" }, fetchImpl: fetchImpl as never })).resolves.toMatchObject({ ok: true, probed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("worker health", () => {
  const now = new Date("2026-10-09T02:00:00Z");
  const store = (rows: Array<{ kind: string; lastSeenAt: Date }>) => ({ workerHeartbeat: { findMany: vi.fn(async () => rows) } }) as never;

  it("a fresh beat is up; a stale or missing one is down with a fix; media-worker from RabbitMQ consumers", async () => {
    const health = await readWorkerHealth(store([{ kind: "workflow", lastSeenAt: new Date(now.getTime() - 5_000) }, { kind: "audio", lastSeenAt: new Date(now.getTime() - HEARTBEAT_STALE_MS - 1) }]), async () => ({ consumers: 1 }), now);
    expect(health.workflow).toMatchObject({ up: true, ageMs: 5_000 });
    expect(health.audio.up).toBe(false);
    expect(health.mediaWorker).toEqual({ up: true, consumers: 1 });
    expect(health.problems).toHaveLength(1);

    const down = await readWorkerHealth(store([]), async () => ({ consumers: 0 }), now);
    expect(down.workflow).toEqual({ up: false, lastSeenAt: null, ageMs: null });
    expect(down.mediaWorker.up).toBe(false);
    expect(down.problems.join(" ")).toContain("corepack pnpm --filter @lyonix/worker dev");
  });
});

describe("Auto preflight (before any AI / TTS / media is spent)", () => {
  const upWorkers: WorkerHealth = { checkedAt: "", workflow: { up: true, lastSeenAt: "", ageMs: 1 }, audio: { up: true, lastSeenAt: "", ageMs: 1 }, mediaWorker: { up: true, consumers: 1 }, problems: [] };
  const facts = (overrides: Partial<AutoPreflightFacts> = {}): AutoPreflightFacts => ({
    workers: upWorkers,
    renderAccount: { ok: true, label: "CREATOMATE (creatomate)" },
    template: { ok: true, name: "News Recap", engine: "creatomate", providerRender: "always", videoSlots: 9, imageSlots: 0, orshotPages: null },
    publicBaseUrl: { ok: true, baseUrl: "https://api.example", probed: true, checkedAt: "", warning: null },
    requestedSceneCount: 10,
    content: { ok: true, models: ["gemini-3.5-flash"] },
    voice: { ok: true, label: "ElevenLabs" },
    media: { ok: true, label: "Pexels" },
    now: new Date("2026-10-09T02:00:00Z"),
    ...overrides,
  });

  it("everything ready -> ok", () => {
    const result = evaluateAutoPreflight(facts());
    expect(result.ok).toBe(true);
    expect(preflightRefusal(result)).toBeNull();
  });

  it("worker not running blocks the submit with the command to start it", () => {
    const result = evaluateAutoPreflight(facts({ workers: { ...upWorkers, workflow: { up: false, lastSeenAt: null, ageMs: null } } }));
    expect(result.ok).toBe(false);
    expect(preflightRefusal(result)).toContain("apps/worker");
    expect(result.checks.find((check) => check.key === "worker")).toMatchObject({ ok: false, severity: "block" });
  });

  it("a dead PUBLIC_BASE_URL blocks a Creatomate job, but only warns when the provider is just a fallback", () => {
    const dead = { ok: false as const, problem: "UNREACHABLE" as const, baseUrl: "https://old.trycloudflare.com", probed: true, checkedAt: "", message: "PUBLIC_BASE_URL không truy cập được" };
    expect(evaluateAutoPreflight(facts({ publicBaseUrl: dead })).ok).toBe(false);
    const lyonix = evaluateAutoPreflight(facts({ publicBaseUrl: dead, template: { ok: true, name: "LyOnix", engine: "lyonix", providerRender: "fallback", videoSlots: 0, imageSlots: 0, orshotPages: null } }));
    expect(lyonix.ok).toBe(true);
    expect(lyonix.checks.find((check) => check.key === "public_base_url")).toMatchObject({ ok: false, severity: "warn" });
  });

  it("an incompatible / not-ready template, a template without media slots and too many scenes for Orshot all block", () => {
    expect(evaluateAutoPreflight(facts({ template: { ok: false, message: "Template này chưa sẵn sàng render: rollout 0 %" } })).ok).toBe(false);
    expect(evaluateAutoPreflight(facts({ template: { ok: true, name: "Text only", engine: "creatomate", providerRender: "always", videoSlots: 0, imageSlots: 0, orshotPages: null } })).checks.find((check) => check.key === "slots")?.ok).toBe(false);
    const orshot = evaluateAutoPreflight(facts({ template: { ok: true, name: "5 pages", engine: "orshot", providerRender: "always", videoSlots: 5, imageSlots: 0, orshotPages: 5 }, requestedSceneCount: 8 }));
    expect(orshot.checks.find((check) => check.key === "scene_count")).toMatchObject({ ok: false, severity: "block" });
    expect(preflightRefusal(orshot)).toContain("tối đa 5");
  });

  it("all content models in cooldown block with the time they come back", () => {
    const result = evaluateAutoPreflight(facts({ content: { ok: false, message: "Mọi model viết kịch bản đang bị giới hạn quota / cooldown.", retryAt: "2026-10-10T00:00:00.000Z" } }));
    expect(result.ok).toBe(false);
    expect(preflightRefusal(result)).toContain("2026-10-10 00:00 UTC");
  });
});

describe("template catalog audit", () => {
  const snapshot = (overrides: Partial<SnapshotFacts>): SnapshotFacts => ({ id: "snap-1", externalTemplateId: "tpl-1", name: "News Recap", engine: "creatomate", providerAccountId: "acc", rolloutPercent: 0, fallbackSnapshotIds: [], modifications: [{ key: "Video-1.source", kind: "video", required: true }, { key: "Text-1.text", kind: "text", required: true }], sceneSlots: 9, createdAt: new Date("2026-10-08"), ...overrides });

  it("Creatomate: real template id + slots, blocked with the reason when media cannot be downloaded", () => {
    const [ready] = auditCreatomate({ accountId: "acc", accountUsable: true, live: { ok: true, templates: [{ externalTemplateId: "tpl-1", name: "News Recap", previewUrl: null }] }, snapshots: [snapshot({})], publicMediaReachable: true });
    expect(ready).toMatchObject({ status: "ready", readinessPct: 100, sceneSupport: { mode: "elastic", templateSceneSlots: 9 }, slots: { video: 1, text: 1, required: 2 } });
    const [dead] = auditCreatomate({ accountId: "acc", accountUsable: true, live: { ok: true, templates: [{ externalTemplateId: "tpl-1", name: "News Recap", previewUrl: null }] }, snapshots: [snapshot({})], publicMediaReachable: false });
    expect(dead!.status).toBe("incompatible");
    expect(dead!.reasons.join(" ")).toContain("PUBLIC_BASE_URL");
    const [gone] = auditCreatomate({ accountId: "acc", accountUsable: true, live: { ok: true, templates: [] }, snapshots: [snapshot({})], publicMediaReachable: true });
    expect(gone!.reasons.join(" ")).toContain("không còn trên Creatomate");
  });

  it("LyOnix: rollout 0 % and a stopped media-worker are reported; 100 % with a worker is ready", () => {
    const recipes = [{ externalTemplateId: "recipe:a@1", name: "A", captionsEnabled: true, slots: [] }];
    const [off] = auditLyonix({ accountId: "ly", recipes, snapshots: [snapshot({ externalTemplateId: "recipe:a@1", engine: "lyonix", rolloutPercent: 0 })], renderConsumers: 1, usableFallbackIds: new Set() });
    expect(off!.reasons.join(" ")).toContain("Rollout 0 %");
    const [on] = auditLyonix({ accountId: "ly", recipes, snapshots: [snapshot({ externalTemplateId: "recipe:a@1", engine: "lyonix", rolloutPercent: 100 })], renderConsumers: 1, usableFallbackIds: new Set() });
    expect(on).toMatchObject({ status: "ready", readinessPct: 100, captions: "voice_timed" });
    const [noWorker] = auditLyonix({ accountId: "ly", recipes, snapshots: [snapshot({ externalTemplateId: "recipe:a@1", engine: "lyonix", rolloutPercent: 100 })], renderConsumers: 0, usableFallbackIds: new Set() });
    expect(noWorker!.reasons.join(" ")).toContain("Media-worker");
  });
});

afterEach(() => vi.restoreAllMocks());
