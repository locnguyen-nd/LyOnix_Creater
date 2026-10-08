import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetVersionSummary } from "@lyonix/contracts";
import type { ApifyDeps } from "@lyonix/providers";
import { deriveSceneBrief } from "@lyonix/domain";
import { ApifyService } from "./apify.service.js";
import type { MediaService } from "./media.service.js";
import { encryptSecret } from "./secret-crypto.js";
import * as safeBinaryFetch from "./safe-binary-fetch.js";

const projectId = "project-1";
const TOKEN = "stub_apify_token_value_000000";
const fakeAsset = { id: "asset-1", projectId, origin: "apify" } as unknown as MediaAssetVersionSummary;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** Stubbed Apify API returning `items` for whichever Actor is started. */
const apifyStub = (items: unknown[]): ApifyDeps & { starts: string[] } => {
  const starts: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url.includes("/runs?")) { starts.push(url); return json({ data: { id: "run1", status: "READY", defaultDatasetId: "ds1" } }, 201); }
    if (url.includes("/v2/actor-runs/run1")) return json({ data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" } });
    if (url.includes("/v2/datasets/ds1/items")) return json(items);
    throw new Error(`unexpected ${url}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, sleep: async () => undefined, starts };
};

const tiktokItem = { id: "7001", text: "夜景", webVideoUrl: "https://www.tiktok.com/@u/video/7001", authorMeta: { name: "creator" }, videoMeta: { duration: 12, coverUrl: "https://p16.tiktokcdn.com/c.jpg" }, mediaUrls: ["https://api.apify.com/v2/key-value-stores/kv1/records/v.mp4"] };
const googleItem = { title: "夜景", imageUrl: "https://blog.example.jp/a.jpg", thumbnailUrl: "https://encrypted-tbn0.gstatic.com/i?q=1", link: "https://blog.example.jp/p" };

describe("ApifyService - VE2E-34", () => {
  let root: string;
  let prevRoot: string | undefined;
  let prevKey: string | undefined;
  let prisma: any;
  let media: { registerAsset: ReturnType<typeof vi.fn> };
  let service: ApifyService;
  let account: Record<string, unknown>;

  beforeEach(async () => {
    prevKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    root = await mkdtemp(join(tmpdir(), "lyonix-apify-"));
    prevRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = root;
    account = { id: "acct-1", provider: "apify", role: "visual", status: "verified", encryptedSecret: encryptSecret(TOKEN), isFake: false, deletedAt: null };
    prisma = {
      project: { findUnique: async ({ where }: any) => (where.id === projectId ? { id: projectId } : null) },
      providerAccount: { findFirst: async () => account },
    };
    media = { registerAsset: vi.fn(async () => fakeAsset) };
    service = new ApifyService(prisma, { forUser: async () => ({ projectIds: [projectId] }) } as any, media as unknown as MediaService);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.PERSISTENCE_ENCRYPTION_KEY = prevKey;
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("searches through the pinned Actor and never returns a download URL or the token to the client", async () => {
    service.apifyDeps = apifyStub([tiktokItem]);
    const outcome = await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "東京 夜景" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.actor).toEqual({ actorId: "clockworks/tiktok-scraper", version: "0.0.611", role: "primary" });
    const [candidate] = outcome.data.candidates;
    expect(candidate).toMatchObject({ platform: "tiktok", importable: true, rightsStatus: "owner_accepted_risk", mediaType: "video" });
    const serialized = JSON.stringify(outcome.data);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("key-value-stores");
    expect(candidate!.importRef).toMatch(/^v1\./);
  });

  it("rejects an unknown platform, an empty query, a wrong-provider or unverified account, and a foreign project", async () => {
    expect(await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "instagram", query: "x" })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "  " })).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await service.search("other", "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "x" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    account = { ...account, provider: "pexels" };
    expect(await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "x" })).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
    account = { ...account, provider: "apify", status: "unverified" };
    expect(await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "x" })).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("caches an identical search for 15 minutes (one paid run); VE2E-131: searches beyond the per-project cap WAIT in a queue instead of failing", async () => {
    const deps = apifyStub([tiktokItem]);
    service.apifyDeps = deps;
    await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "夜景" });
    await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "夜景" });
    expect(deps.starts).toHaveLength(1);

    process.env.APIFY_MAX_CONCURRENT_RUNS = "3";
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const slow = apifyStub([tiktokItem]);
      const original = slow.fetch!;
      slow.fetch = (async (input: string | URL | Request, init?: RequestInit) => { await gate; return original(input, init); }) as typeof fetch;
      service.apifyDeps = slow;
      const queries = ["桜", "ラーメン", "寿司"];
      const running = queries.map((query) => service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query }));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      let settled = false;
      const fourth = service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "温泉" }).then((r) => { settled = true; return r; });
      const sameAsFirst = service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "桜" });
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      expect(settled).toBe(false); // queued, not PROVIDER_RATE_LIMITED
      expect(slow.starts).toHaveLength(0);
      release();
      const all = await Promise.all([...running, fourth, sameAsFirst]);
      expect(all.every((r) => r.ok)).toBe(true);
      expect(slow.starts).toHaveLength(4);
    } finally {
      delete process.env.APIFY_MAX_CONCURRENT_RUNS;
    }
  });

  it("VE2E-131: a search that waits longer than APIFY_QUEUE_WAIT_TIMEOUT_MS ends as a retryable PROVIDER_RATE_LIMITED", async () => {
    process.env.APIFY_MAX_CONCURRENT_RUNS = "1";
    process.env.APIFY_QUEUE_WAIT_TIMEOUT_MS = "1000";
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const slow = apifyStub([tiktokItem]);
      const original = slow.fetch!;
      slow.fetch = (async (input: string | URL | Request, init?: RequestInit) => { await gate; return original(input, init); }) as typeof fetch;
      service.apifyDeps = slow;
      const first = service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "桜" });
      const second = await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "寿司" });
      expect(second).toMatchObject({ ok: false, code: "PROVIDER_RATE_LIMITED", retryable: true });
      release();
      expect((await first).ok).toBe(true);
    } finally {
      delete process.env.APIFY_MAX_CONCURRENT_RUNS;
      delete process.env.APIFY_QUEUE_WAIT_TIMEOUT_MS;
    }
  }, 10_000);

  it("imports a TikTok candidate via api.apify.com with the server-side token, registers origin=apify with provenance", async () => {
    service.apifyDeps = apifyStub([tiktokItem]);
    const search = await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "夜景" });
    if (!search.ok) throw new Error("search failed");
    const fetchSpy = vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: MP4, mimeType: "video/mp4", finalUrl: "x" });
    const imported = await service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef: search.data.candidates[0]!.importRef!, sceneId: "s1" });
    expect(imported).toEqual({ ok: true, data: { asset: fakeAsset } });
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.apify.com/v2/key-value-stores/kv1/records/v.mp4");
    expect(options).toMatchObject({ allowedHostSuffixes: ["api.apify.com"], hostScopedHeaders: { host: "api.apify.com", headers: { Authorization: `Bearer ${TOKEN}` } } });
    const registered = media.registerAsset.mock.calls[0]![3];
    expect(registered).toMatchObject({ origin: "apify", kind: "video", sceneId: "s1", mimeType: "video/mp4" });
    expect(registered.serverProvenance).toMatchObject({ platform: "tiktok", rightsStatus: "owner_accepted_risk", audioPolicy: "strip_audio", apify: { actorId: "clockworks/tiktok-scraper", actorVersion: "0.0.611" } });
    expect(registered.originalFileName).toMatch(/^apify-tiktok-7001\.mp4$/);
  });

  it("imports a Google image in public-web mode (images only, no suffix list)", async () => {
    service.apifyDeps = apifyStub([googleItem]);
    const search = await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "google_image", query: "夜景" });
    if (!search.ok) throw new Error("search failed");
    const fetchSpy = vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: JPEG, mimeType: "image/jpeg", finalUrl: "x" });
    expect((await service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef: search.data.candidates[0]!.importRef! })).ok).toBe(true);
    const options = fetchSpy.mock.calls[0]![1];
    expect(options.allowedHostSuffixes).toBeUndefined();
    expect(options.allowedMimePrefixes).toEqual(["image/"]);
    expect(options.hostScopedHeaders).toBeUndefined();
  });

  it("maps safe-fetch refusals to SSRF_BLOCKED / 415 and refuses bytes that are not the declared media kind", async () => {
    service.apifyDeps = apifyStub([googleItem]);
    const search = await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "google_image", query: "夜景" });
    if (!search.ok) throw new Error("search failed");
    const ref = search.data.candidates[0]!.importRef!;
    const spy = vi.spyOn(safeBinaryFetch, "fetchBinarySafely");
    spy.mockResolvedValueOnce({ ok: false, reason: "ssrf_blocked" });
    expect(await service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef: ref })).toMatchObject({ ok: false, code: "SSRF_BLOCKED" });
    spy.mockResolvedValueOnce({ ok: false, reason: "mime_not_allowed" });
    expect(await service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef: ref })).toMatchObject({ ok: false, code: "UNSUPPORTED_MEDIA" });
    spy.mockResolvedValueOnce({ ok: true, buffer: Buffer.from("<html>not an image</html>"), mimeType: "image/jpeg", finalUrl: "x" });
    expect(await service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef: ref })).toMatchObject({ ok: false, code: "UNSUPPORTED_MEDIA" });
    expect(media.registerAsset).not.toHaveBeenCalled();
  });

  it("rejects a forged, tampered, expired, cross-project or cross-account importRef and a preview-only candidate has none", async () => {
    service.apifyDeps = apifyStub([tiktokItem, { ...tiktokItem, id: "7002", mediaUrls: [] }]);
    const search = await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "tiktok", query: "夜景" });
    if (!search.ok) throw new Error("search failed");
    const [good, previewOnly] = search.data.candidates;
    expect(previewOnly).toMatchObject({ importable: false, importRef: null, previewOnlyReason: "no_apify_stored_file" });
    const spy = vi.spyOn(safeBinaryFetch, "fetchBinarySafely");
    const bad = async (importRef: string) => service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef });
    expect(await bad("https://evil.example/a.mp4")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await bad(`${good!.importRef!.slice(0, -3)}AAA`)).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await bad(encryptSecret(JSON.stringify({ v: 1, exp: Date.now() - 1000, projectId, providerAccountId: "acct-1", platform: "tiktok", download: { url: "https://api.apify.com/v2/key-value-stores/k/records/a", kind: "video", policy: "apify_api", hostSuffixes: ["api.apify.com"], maxBytes: 10 }, meta: {}, provenance: {} })))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await service.import("project-1", "u1", "staff", { providerAccountId: "acct-1", importRef: encryptSecret(JSON.stringify({ v: 1, exp: Date.now() + 60000, projectId: "other", providerAccountId: "acct-1", platform: "tiktok", download: { url: "https://api.apify.com/v2/key-value-stores/k/records/a", kind: "video", policy: "apify_api", hostSuffixes: ["api.apify.com"], maxBytes: 10 }, meta: {}, provenance: {} })) })).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a sealed plan whose host is outside the fixed allowlist (defence in depth)", async () => {
    const forged = (url: string, suffixes: string[]) => encryptSecret(JSON.stringify({ v: 1, exp: Date.now() + 60000, projectId, providerAccountId: "acct-1", platform: "pinterest", download: { url, kind: "image", policy: "suffix", hostSuffixes: suffixes, maxBytes: 10 }, meta: { externalId: "x", mediaType: "photo", widthPx: null, heightPx: null, durationSeconds: null, title: "" }, provenance: {} }));
    const spy = vi.spyOn(safeBinaryFetch, "fetchBinarySafely");
    expect(await service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef: forged("https://evil.example/a.jpg", ["evil.example"]) })).toMatchObject({ ok: false, code: "SSRF_BLOCKED" });
    expect(await service.import(projectId, "u1", "staff", { providerAccountId: "acct-1", importRef: forged("https://evilpinimg.com/a.jpg", ["pinimg.com"]) })).toMatchObject({ ok: false, code: "SSRF_BLOCKED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes the real (redacted) Apify error through when the search fails", async () => {
    service.apifyDeps = { fetch: (async () => json({ error: { message: "Actor build not found" } }, 404)) as unknown as typeof fetch, sleep: async () => undefined };
    const outcome = await service.search(projectId, "u1", "staff", { providerAccountId: "acct-1", platform: "pinterest", query: "夜景" });
    expect(outcome).toMatchObject({ ok: false, code: "PROVIDER_SCHEMA_INVALID" });
    if (!outcome.ok) expect(outcome.message).toContain("Actor build not found");
  });
});

describe("ApifyService.autoImportForSegment - VE2E-46 pool rules", () => {
  let root: string;
  let prevRoot: string | undefined;
  let prevKey: string | undefined;
  let media: { registerAsset: ReturnType<typeof vi.fn> };
  let service: ApifyService;
  const account = () => ({ id: "acct-1", encryptedSecret: encryptSecret(TOKEN) });
  const brief = () => deriveSceneBrief({ language: "ja", scenes: [{ sceneId: "s1", narration: "", screenText: "", visualQuery: "東京 夜景", durationHintMs: 5000 }] }, 0);
  const input = (platform: "tiktok" | "pinterest" | "google_video" = "tiktok") => ({ platform, keyword: "東京 夜景", brief: brief(), sceneId: "s1", usedExternalIds: new Set<string>() });

  beforeEach(async () => {
    process.env.APIFY_TWO_PHASE = "0"; // these VE2E-46 rules are written against the single-phase flow
    prevKey = process.env.PERSISTENCE_ENCRYPTION_KEY;
    process.env.PERSISTENCE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    root = await mkdtemp(join(tmpdir(), "lyonix-apify-auto-"));
    prevRoot = process.env.MEDIA_ROOT;
    process.env.MEDIA_ROOT = root;
    media = { registerAsset: vi.fn(async () => fakeAsset) };
    const prisma: any = { project: { findUnique: async () => ({ id: projectId }) }, providerAccount: { findFirst: async () => null } };
    service = new ApifyService(prisma, { forUser: async () => ({ projectIds: [projectId] }) } as any, media as unknown as MediaService);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.PERSISTENCE_ENCRYPTION_KEY = prevKey;
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("imports the best importable candidate with the ja keyword and returns ledger id + provenance", async () => {
    service.apifyDeps = apifyStub([tiktokItem]);
    vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: MP4, mimeType: "video/mp4", finalUrl: "x" });
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), input());
    expect(outcome).toMatchObject({ ok: true, data: { ledgerId: "apify:tiktok:7001", externalId: "7001", platform: "tiktok", provenance: { actorId: "clockworks/tiktok-scraper", author: "creator" } } });
    expect(media.registerAsset.mock.calls[0]![3]).toMatchObject({ origin: "apify", sceneId: "s1" });
  });

  it("drops preview-only candidates before ranking (TikTok without a stored file never enters the pool)", async () => {
    service.apifyDeps = apifyStub([{ ...tiktokItem, mediaUrls: [] }]);
    const fetchSpy = vi.spyOn(safeBinaryFetch, "fetchBinarySafely");
    expect(await service.autoImportForSegment(projectId, "u1", "staff", account(), input())).toMatchObject({ ok: false, reason: "apify_no_usable_candidate" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Pinterest HLS-only pins never enter the pool", async () => {
    service.apifyDeps = apifyStub([{ id: "p2", pin: { is_video: true }, media: { video: { hls_url: "https://v1.pinimg.com/videos/a.m3u8", thumbnail: "https://i.pinimg.com/x.jpg" } } }]);
    expect(await service.autoImportForSegment(projectId, "u1", "staff", account(), input("pinterest"))).toMatchObject({ ok: false, reason: "apify_no_usable_candidate" });
  });

  it("refuses google_video outright without calling Apify", async () => {
    const deps = apifyStub([]);
    service.apifyDeps = deps;
    expect(await service.autoImportForSegment(projectId, "u1", "staff", account(), input("google_video"))).toEqual({ ok: false, reason: "platform_not_importable" });
    expect(deps.starts).toHaveLength(0);
  });

  it("reports Apify search errors and failed imports as fallback reasons instead of throwing", async () => {
    service.apifyDeps = { fetch: (async () => json({ error: { message: "nope" } }, 500)) as unknown as typeof fetch, sleep: async () => undefined };
    expect(await service.autoImportForSegment(projectId, "u1", "staff", account(), input())).toMatchObject({ ok: false, reason: "apify_error:PROVIDER_UNAVAILABLE" });
    service.apifyDeps = apifyStub([{ ...tiktokItem, id: "7002" }]);
    vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: false, reason: "fetch_failed" });
    expect(await service.autoImportForSegment(projectId, "u1", "staff", account(), input())).toMatchObject({ ok: false, reason: expect.stringContaining("apify_import_failed:VALIDATION_FAILED") });
  });

  it("excludes sources an earlier segment already used", async () => {
    service.apifyDeps = apifyStub([tiktokItem]);
    const outcome = await service.autoImportForSegment(projectId, "u1", "staff", account(), { ...input(), usedExternalIds: new Set(["7001"]) });
    expect(outcome.ok).toBe(false);
  });

  it("findAccountForUser only returns a usable Apify account visible to the user", async () => {
    const seen: any[] = [];
    const prisma: any = { providerAccount: { findFirst: vi.fn(async (args: any) => { seen.push(args); return args.where.provider === "apify" || args.where.id ? { id: "acct-1", provider: "apify", role: "visual", status: "verified", isFake: false, deletedAt: null, encryptedSecret: "enc" } : null; }) } };
    const svc = new ApifyService(prisma, {} as any, media as unknown as MediaService);
    expect(await svc.findAccountForUser("u1", "staff")).toEqual({ id: "acct-1", encryptedSecret: "enc" });
    expect(seen[0].where.OR).toEqual([{ scope: "organization" }, { scope: "personal", ownerUserId: "u1" }]);
    expect(seen[0].where).toMatchObject({ provider: "apify", role: "visual", deletedAt: null });
    const empty = new ApifyService({ providerAccount: { findFirst: async () => null } } as any, {} as any, media as unknown as MediaService);
    expect(await empty.findAccountForUser("u1", "admin")).toBeNull();
  });
});
