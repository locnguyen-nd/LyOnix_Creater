import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialSearchItem } from "@lyonix/media-jobs";
import type { ApifyService } from "./apify.service.js";
import { MediaPlanService, SegmentSourceLedger, type MediaPlanScript } from "./media-plan.service.js";
import type { MediaService } from "./media.service.js";
import type { PexelsService } from "./pexels.service.js";
import type { SocialFetchOutcome, SocialFetchService, SocialSearchOutcome } from "./social-fetch.service.js";
import { SocialSourceService, socialLedgerIdFromFileName } from "./social-source.service.js";
import * as safeBinaryFetch from "./safe-binary-fetch.js";

// VE2E-147/148: Shorts / gallery tiers. Search + download are fakes (the worker is never called), files go to a temp MEDIA_ROOT.

const projectId = "project-1";
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const shortItem = (id: string, over: Partial<SocialSearchItem> = {}): SocialSearchItem => ({
  url: `https://www.youtube.com/shorts/${id}`, externalId: id, mediaType: "video", title: "東京 夜景 shorts", description: null, uploader: "jp", channel: "jp ch", webpageUrl: null,
  durationSeconds: 30, width: 1080, height: 1920, thumbnailUrl: null, viewCount: 100, likeCount: null, uploadDate: null, tags: [], language: null, ...over,
});

let root: string;
let prevRoot: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lyonix-social-"));
  prevRoot = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = root;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
  for (const name of ["MEDIA_SOURCE_YT_SHORTS", "MEDIA_FETCH_GALLERYDL", "APIFY_VIDEO_PLATFORMS"]) delete process.env[name];
  await rm(root, { recursive: true, force: true });
});

const fakeSocialFetch = (items: SocialSearchItem[], download: (url: string) => Buffer | string) => {
  const search = vi.fn(async (): Promise<SocialSearchOutcome> => ({ ok: true, items, steps: [], elapsedMs: 5 }));
  const fetchPost = vi.fn(async (input: { url: string }): Promise<SocialFetchOutcome> => {
    const r = download(input.url);
    if (typeof r === "string") return { ok: false, code: r as any, message: r, steps: [], elapsedMs: 7 };
    const token = randomUUID();
    await mkdir(join(root, "_quarantine"), { recursive: true });
    await writeFile(join(root, "_quarantine", token), r);
    return {
      ok: true, steps: [], elapsedMs: 9,
      result: { schemaVersion: "media-job.v1", type: "media.fetch.result", ok: true, jobKey: "k", quarantineToken: token, bytes: r.byteLength, sha256: "b".repeat(64), probe: { durationMs: 30_000, width: 1080, height: 1920, videoCodec: "h264" }, info: {} as any, attempts: [], tool: { name: "yt-dlp", version: "2026.08.19", profileVersion: "media-fetch.v1" }, elapsedMs: 9, completedAt: "" },
    };
  });
  return { search, fetchPost } as unknown as SocialFetchService & { search: typeof search; fetchPost: typeof fetchPost };
};

const media = () => ({ registerAsset: vi.fn(async (_p: string, _u: string, _r: string, input: any) => ({ id: `asset-${input.originalFileName}`, kind: input.kind, durationMs: input.durationMs })) });
const prisma = (existing: Record<string, unknown> | null = null) => ({ mediaAssetVersion: { findFirst: vi.fn(async () => existing) }, project: { findUnique: async () => ({ id: projectId }) } });
const baseInput = (over: Record<string, unknown> = {}) => ({ platform: "youtube" as const, tool: "yt-dlp" as const, queries: ["東京 夜景"], mediaType: "video" as const, segmentDurationSeconds: 8, usedExternalIds: new Set<string>(), subjectAliases: [], keywords: [], sceneId: "s1", ...over });

describe("SocialSourceService (VE2E-147/148)", () => {
  it("search -> best Short -> download -> registered as origin social with provenance; id claimed in the live set", async () => {
    const fetch = fakeSocialFetch([shortItem("aaaaaaaaaaa")], () => MP4);
    const m = media();
    const used = new Set<string>();
    const out = await new SocialSourceService(prisma() as any, m as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput({ usedExternalIds: used }));
    expect(out).toMatchObject({ ok: true, data: { externalId: "aaaaaaaaaaa", ledgerId: "social:youtube:aaaaaaaaaaa", reused: false } });
    expect(used.has("aaaaaaaaaaa")).toBe(true);
    const registered = m.registerAsset.mock.calls[0]![3];
    expect(registered).toMatchObject({ origin: "social", kind: "video", originalFileName: "social-youtube-aaaaaaaaaaa.mp4", durationMs: 30_000 });
    expect(registered.serverProvenance).toMatchObject({ platform: "youtube", rightsStatus: "owner_accepted_risk", decision: "DEC-2026-10-08-SOCIAL-FETCH-OSS", sourceUrl: "https://www.youtube.com/shorts/aaaaaaaaaaa", audioPolicy: "strip_audio", downloader: { tool: "yt-dlp" } });
    expect(socialLedgerIdFromFileName("social-youtube-aaaaaaaaaaa.mp4")).toBe("social:youtube:aaaaaaaaaaa");
  });

  it("a failed download releases the claim and the next result is tried", async () => {
    const fetch = fakeSocialFetch([shortItem("bbbbbbbbbbb", { viewCount: 1e6 }), shortItem("ccccccccccc")], (url) => (url.includes("bbbbbbbbbbb") ? "FETCH_BOT_CHECK" : MP4));
    const used = new Set<string>();
    const out = await new SocialSourceService(prisma() as any, media() as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput({ usedExternalIds: used }));
    expect(out.ok && out.data.externalId).toBe("ccccccccccc");
    expect(used.has("bbbbbbbbbbb")).toBe(false);
    expect(out.ok && out.data.diagnostics.downloads.map((d) => d.code)).toEqual(["FETCH_BOT_CHECK", null]);
  });

  it("a breaker-open / worker-down answer stops the tier at once (the ladder falls through)", async () => {
    const fetch = fakeSocialFetch([], () => MP4);
    (fetch.search as any).mockResolvedValue({ ok: false, code: "FETCH_BREAKER_OPEN", message: "", steps: [], elapsedMs: 0 });
    const out = await new SocialSourceService(prisma() as any, media() as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput({ queries: ["a", "b"] }));
    expect(out).toMatchObject({ ok: false, reason: "search:FETCH_BREAKER_OPEN" });
    expect(fetch.search).toHaveBeenCalledTimes(1);
  });

  it("off-subject / used results are never downloaded", async () => {
    const fetch = fakeSocialFetch([shortItem("ddddddddddd", { title: "教会" }), shortItem("eeeeeeeeeee", { title: "メッシ" })], () => MP4);
    const out = await new SocialSourceService(prisma() as any, media() as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput({ subjectAliases: ["メッシ"], usedExternalIds: new Set(["eeeeeeeeeee"]) }));
    expect(out).toMatchObject({ ok: false, reason: "no_usable_candidate" });
    expect(fetch.fetchPost).not.toHaveBeenCalled();
    expect(!out.ok && out.diagnostics.rejected).toMatchObject({ off_subject: 1, used: 1 });
  });

  it("reuses the project's earlier import of the same Short (no download)", async () => {
    const fetch = fakeSocialFetch([shortItem("fffffffffff")], () => MP4);
    const out = await new SocialSourceService(prisma({ id: "old-asset", kind: "video", durationMs: 20_000 }) as any, media() as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput());
    expect(out).toMatchObject({ ok: true, data: { asset: { id: "old-asset" }, reused: true } });
    expect(fetch.fetchPost).not.toHaveBeenCalled();
  });

  it("gallery-dl image: wrong bytes are discarded from quarantine and not registered", async () => {
    const fetch = fakeSocialFetch([shortItem("1001", { mediaType: "image", url: "https://www.pinterest.com/pin/1001/", durationSeconds: null })], () => Buffer.from("<html>"));
    const m = media();
    const out = await new SocialSourceService(prisma() as any, m as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput({ platform: "pinterest", tool: "gallery-dl", mediaType: "image" }));
    expect(out.ok).toBe(false);
    expect(m.registerAsset).not.toHaveBeenCalled();
    expect((await readdir(join(root, "_quarantine"))).length).toBe(0);
    const ok = fakeSocialFetch([shortItem("1002", { mediaType: "image", url: "https://www.pinterest.com/pin/1002/", durationSeconds: null })], () => JPG);
    const out2 = await new SocialSourceService(prisma() as any, m as unknown as MediaService, ok).autoImportForSegment(projectId, "u", "staff", baseInput({ platform: "pinterest", tool: "gallery-dl", mediaType: "image" }));
    expect(out2.ok).toBe(true);
    expect(m.registerAsset.mock.calls[0]![3]).toMatchObject({ kind: "image", originalFileName: "social-pinterest-1002.jpg", durationMs: null, origin: "social" });
  });
});

describe("SocialSourceService direct image fast path (probe 08/10)", () => {
  const pin = (id: string, mediaUrl: string | null) => shortItem(id, { mediaType: "image", url: `https://www.pinterest.com/pin/${id}/`, durationSeconds: null, mediaUrl });

  it("downloads a search-returned pinimg URL directly: no worker job, registered with downloader 'direct'", async () => {
    const spy = vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: true, buffer: JPG, mimeType: "image/jpeg", finalUrl: "x" });
    const fetch = fakeSocialFetch([pin("2001", "https://i.pinimg.com/originals/a.jpg")], () => JPG);
    const m = media();
    const out = await new SocialSourceService(prisma() as any, m as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput({ platform: "pinterest", tool: "gallery-dl", mediaType: "image" }));
    expect(out.ok).toBe(true);
    expect(fetch.fetchPost).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("https://i.pinimg.com/originals/a.jpg", expect.objectContaining({ allowedHostSuffixes: ["pinimg.com", "twimg.com"], allowedMimePrefixes: ["image/"] }));
    expect(m.registerAsset.mock.calls[0]![3].serverProvenance.downloader.tool).toBe("direct");
    expect(out.ok && out.data.diagnostics.downloads[0]!.via).toBe("direct");
  });

  it("a failed direct GET falls back to gallery-dl through the worker", async () => {
    vi.spyOn(safeBinaryFetch, "fetchBinarySafely").mockResolvedValue({ ok: false, reason: "fetch_failed" });
    const fetch = fakeSocialFetch([pin("2002", "https://i.pinimg.com/originals/b.jpg")], () => JPG);
    const out = await new SocialSourceService(prisma() as any, media() as unknown as MediaService, fetch).autoImportForSegment(projectId, "u", "staff", baseInput({ platform: "pinterest", tool: "gallery-dl", mediaType: "image" }));
    expect(out.ok).toBe(true);
    expect(fetch.fetchPost).toHaveBeenCalledTimes(1);
  });
});

describe("MediaPlanService with the Shorts tier (VE2E-148)", () => {
  const script = (): MediaPlanScript => ({
    language: "ja",
    scenes: [{ sceneId: "s1", narration: "一つ目。", screenText: "one", visualQuery: "tokyo", durationHintMs: 5000, voiceDurationMs: 4000 }],
    visualPlan: { segments: [{ segmentId: "g1", sceneIds: ["s1"], subject: "夜の東京", priority: 1, keywords: { ja: "東京 夜景", en: "tokyo night" }, styleHints: { setting: "", timeOfDay: "", lighting: "", palette: "" } }] } as any,
  });
  const grants: any = { forUser: async () => ({ teamIds: [], projectIds: [projectId], channelIds: [] }) };
  const pexelsOk = () => ({ autoImportForScene: vi.fn(async () => ({ ok: true as const, data: { asset: { id: "pexels-asset", kind: "video", durationMs: 30_000 } as any, externalId: "px1" } })) });
  const social = (ok: boolean) => ({ autoImportForSegment: vi.fn(async () => (ok ? { ok: true, data: { asset: { id: "short-asset", kind: "video", durationMs: 30_000 }, externalId: "abcdefghijk", ledgerId: "social:youtube:abcdefghijk", sourceUrl: "u", author: null, reused: false, diagnostics: {} } } : { ok: false, reason: "no_usable_candidate", diagnostics: {} })) });

  it("Shorts beats Pexels when Apify has nothing; flag off = never called", async () => {
    process.env.APIFY_VIDEO_PLATFORMS = "tiktok";
    const apify = { findAccountForUser: vi.fn(async () => ({ id: "acc", encryptedSecret: "x" })), autoImportForSegment: vi.fn(async () => ({ ok: false, reason: "apify_no_usable_candidate" })) };
    const s = social(true);
    const build = () => new MediaPlanService(prisma() as any, grants, pexelsOk() as unknown as PexelsService, apify as unknown as ApifyService, undefined, undefined, undefined, s as any);
    let svc = build();
    let segment = svc.planSegments(script(), { min: 1, max: 1 })[0]!;
    const off = await svc.importSegmentSource(projectId, "u", "staff", { providerAccountId: "pexels-acc", script: script(), segment, ledger: new SegmentSourceLedger() });
    expect(off.ok && off.data.provider).toBe("pexels");
    expect(s.autoImportForSegment).not.toHaveBeenCalled();

    process.env.MEDIA_SOURCE_YT_SHORTS = "1";
    svc = build();
    segment = svc.planSegments(script(), { min: 1, max: 1 })[0]!;
    const on = await svc.importSegmentSource(projectId, "u", "staff", { providerAccountId: "pexels-acc", script: script(), segment, ledger: new SegmentSourceLedger() });
    expect(on).toMatchObject({ ok: true, data: { mediaAssetVersionId: "short-asset", provider: "social", tier: "shorts", externalId: "social:youtube:abcdefghijk" } });
    expect((s.autoImportForSegment.mock.calls[0] as any)[3]).toMatchObject({ platform: "youtube", tool: "yt-dlp", mediaType: "video" });
  });

  it("the ja Apify tier still wins over Shorts (priority ja > en > shorts)", async () => {
    process.env.MEDIA_SOURCE_YT_SHORTS = "1";
    process.env.APIFY_VIDEO_PLATFORMS = "tiktok";
    const apify = {
      findAccountForUser: vi.fn(async () => ({ id: "acc", encryptedSecret: "x" })),
      autoImportForSegment: vi.fn(async () => ({ ok: true, data: { asset: { id: "tiktok-asset", kind: "video", durationMs: 12_000 }, externalId: "7001", ledgerId: "apify:tiktok:7001", platform: "tiktok", provenance: null, quality: {} } })),
    };
    const svc = new MediaPlanService(prisma() as any, grants, pexelsOk() as unknown as PexelsService, apify as unknown as ApifyService, undefined, undefined, undefined, social(true) as any);
    const segment = svc.planSegments(script(), { min: 1, max: 1 })[0]!;
    const out = await svc.importSegmentSource(projectId, "u", "staff", { providerAccountId: "pexels-acc", script: script(), segment, ledger: new SegmentSourceLedger() });
    expect(out.ok && out.data.mediaAssetVersionId).toBe("tiktok-asset");
  });
});
