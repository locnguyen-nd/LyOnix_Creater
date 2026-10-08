import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClipPrepareJobKey, MediaJobClientError } from "@lyonix/media-jobs";
import { ClipDerivativesService, decideStripAudio, derivativeMatches } from "./clip-derivatives.service.js";
import { failedClipResult, mediaAssetStore, okClipResult, startStubMediaWorker, type StoredAsset } from "./clip-derivatives.test-helpers.js";

const projectId = "project-1";
const pexelsParent: StoredAsset = { id: "parent-pexels", projectId, kind: "video", origin: "pexels", bytes: 60_000_000, relativePath: "projects/project-1/assets/p.mp4", originalFileName: "pexels-123.mp4", license: "Pexels", provenance: { attribution: { photographerName: "A" } } };
const apifyParent: StoredAsset = { id: "parent-apify", projectId, kind: "video", origin: "apify", bytes: 20_000_000, relativePath: "projects/project-1/assets/a.mp4", originalFileName: "tiktok.mp4" };
const imageParent: StoredAsset = { id: "parent-image", projectId, kind: "image", origin: "upload", bytes: 1000, relativePath: "projects/project-1/assets/i.jpg", originalFileName: "i.jpg" };

let mediaRootDir: string;
let previousMediaRoot: string | undefined;

beforeEach(async () => {
  mediaRootDir = await mkdtemp(join(tmpdir(), "lyonix-clip-deriv-"));
  previousMediaRoot = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = mediaRootDir;
});

afterEach(async () => {
  if (previousMediaRoot === undefined) delete process.env.MEDIA_ROOT;
  else process.env.MEDIA_ROOT = previousMediaRoot;
  await rm(mediaRootDir, { recursive: true, force: true });
});

const setup = async (behavior?: Parameters<typeof startStubMediaWorker>[0], assets: StoredAsset[] = [pexelsParent, apifyParent, imageParent]) => {
  const worker = await startStubMediaWorker(behavior);
  const store = mediaAssetStore(assets);
  const service = new ClipDerivativesService({ mediaAssetVersion: store } as never, worker.client);
  const logs: string[] = [];
  service.log = (message) => logs.push(message);
  return { worker, store, service, logs };
};

describe("decideStripAudio / derivativeMatches", () => {
  it("always strips social (apify) audio; otherwise strips unless the caller keeps source audio", () => {
    expect(decideStripAudio("apify", true)).toBe(true);
    expect(decideStripAudio("pexels", false)).toBe(true);
    expect(decideStripAudio("pexels", true)).toBe(false);
  });

  it("matches only the exact range and audio policy", () => {
    const transform = { range: { startMs: 1000, durationMs: 4000 }, stripAudio: true, tool: null, profileVersion: null };
    expect(derivativeMatches(transform, { startMs: 1000, durationMs: 4000 }, true)).toBe(true);
    expect(derivativeMatches(transform, { startMs: 1000, durationMs: 4000 }, false)).toBe(false);
    expect(derivativeMatches(transform, { startMs: 1001, durationMs: 4000 }, true)).toBe(false);
    expect(derivativeMatches(null, { startMs: 1000, durationMs: 4000 }, true)).toBe(false);
  });
});

describe("ClipDerivativesService.prepare", () => {
  it("cuts via media-worker with a deterministic jobKey and registers a working derivative with lineage", async () => {
    const { worker, store, service, logs } = await setup();
    const outcome = await service.prepare(projectId, "user-1", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 2000, durationMs: 4000, stripAudio: true }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(worker.jobs).toHaveLength(1);
    expect(worker.jobs[0]).toMatchObject({
      jobKey: buildClipPrepareJobKey({ sourceMediaAssetVersionId: pexelsParent.id, startMs: 2000, durationMs: 4000, stripAudio: true }),
      source: { relativePath: pexelsParent.relativePath, mediaAssetVersionId: pexelsParent.id },
      stripAudio: true,
    });
    const derivativeId = outcome.data.derivativeBySceneId.get("s1")!;
    const row = store.rows.get(derivativeId)!;
    expect(row).toMatchObject({
      parentMediaAssetVersionId: pexelsParent.id,
      transform: { range: { startMs: 2000, durationMs: 4000 }, stripAudio: true, tool: { name: "ffmpeg", version: "ffmpeg version test" }, profileVersion: "clip-prepare.v2" },
      kind: "video",
      origin: "pexels",
      license: "Pexels",
      reusable: false,
      retentionClass: "working",
      bytes: 2_000_000,
      checksumSha256: "a".repeat(64),
    });
    expect((row.provenance as any).attribution).toEqual({ photographerName: "A" }); // parent attribution follows the clip
    expect((row.provenance as any).derivative).toMatchObject({ mode: "copy", parentBytes: 60_000_000 });
    expect(outcome.data.totals).toEqual({ parentBytes: 60_000_000, derivativeBytes: 2_000_000 });
    expect(logs.join("\n")).toContain("57.22MB -> 1.91MB");
    expect(logs.join("\n")).toContain("97% smaller");
  });

  it("forces stripAudio for social (apify) parents even when the caller wants source audio", async () => {
    const { worker, store, service } = await setup();
    const outcome = await service.prepare(projectId, "user-1", [{ sceneId: "s1", parentMediaAssetVersionId: apifyParent.id, startMs: 0, durationMs: 3000, stripAudio: false }]);
    expect(outcome.ok).toBe(true);
    expect(worker.jobs[0]!.stripAudio).toBe(true);
    if (outcome.ok) expect((store.rows.get(outcome.data.derivativeBySceneId.get("s1")!)!.transform as any).stripAudio).toBe(true);
  });

  it("keeps source audio for a non-social parent when the caller asks for it", async () => {
    const { worker, service } = await setup();
    await service.prepare(projectId, "user-1", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: false }]);
    expect(worker.jobs[0]!.stripAudio).toBe(false);
  });

  it("dedupes scenes sharing the same (parent, range, audio) into one job", async () => {
    const { worker, service } = await setup();
    const outcome = await service.prepare(projectId, "user-1", [
      { sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true },
      { sceneId: "s2", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true },
      { sceneId: "s3", parentMediaAssetVersionId: pexelsParent.id, startMs: 3000, durationMs: 3000, stripAudio: true },
    ]);
    expect(worker.jobs).toHaveLength(2);
    if (outcome.ok) expect(outcome.data.derivativeBySceneId.get("s1")).toBe(outcome.data.derivativeBySceneId.get("s2"));
  });

  it("reuses a registered derivative whose file is on disk and not near expiry, without calling the worker", async () => {
    const relativePath = "working/media-jobs/x/clip.mp4";
    await mkdir(join(mediaRootDir, "working/media-jobs/x"), { recursive: true });
    await writeFile(join(mediaRootDir, relativePath), Buffer.alloc(1234));
    const existing: StoredAsset = {
      id: "deriv-existing", projectId, kind: "video", origin: "pexels", bytes: 1234, relativePath, originalFileName: "c.mp4",
      parentMediaAssetVersionId: pexelsParent.id, transform: { range: { startMs: 2000, durationMs: 4000 }, stripAudio: true, tool: null, profileVersion: null },
      expiresAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    };
    const { worker, service } = await setup(undefined, [pexelsParent, existing]);
    const outcome = await service.prepare(projectId, "user-1", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 2000, durationMs: 4000, stripAudio: true }]);
    expect(outcome.ok && outcome.data.derivativeBySceneId.get("s1")).toBe("deriv-existing");
    expect(outcome.ok && outcome.data.items[0]!.source).toBe("registry");
    expect(worker.jobs).toHaveLength(0);
  });

  it("does not reuse a derivative whose file is gone, that expires soon, or with a different audio policy", async () => {
    const base = { projectId, kind: "video" as const, origin: "pexels", bytes: 10, originalFileName: "c.mp4", parentMediaAssetVersionId: pexelsParent.id };
    await mkdir(join(mediaRootDir, "working/media-jobs/soon"), { recursive: true });
    await writeFile(join(mediaRootDir, "working/media-jobs/soon/clip.mp4"), Buffer.alloc(10));
    const assets: StoredAsset[] = [
      pexelsParent,
      { ...base, id: "gone", relativePath: "working/media-jobs/gone/clip.mp4", transform: { range: { startMs: 0, durationMs: 1000 }, stripAudio: true, tool: null, profileVersion: null }, expiresAt: new Date(Date.now() + 86_400_000) },
      { ...base, id: "soon", relativePath: "working/media-jobs/soon/clip.mp4", transform: { range: { startMs: 0, durationMs: 1000 }, stripAudio: true, tool: null, profileVersion: null }, expiresAt: new Date(Date.now() + 60_000) },
      { ...base, id: "with-audio", relativePath: "working/media-jobs/soon/clip.mp4", transform: { range: { startMs: 0, durationMs: 1000 }, stripAudio: false, tool: null, profileVersion: null }, expiresAt: new Date(Date.now() + 86_400_000) },
    ];
    const { worker, service } = await setup(undefined, assets);
    const outcome = await service.prepare(projectId, "user-1", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 1000, stripAudio: true }]);
    expect(worker.jobs).toHaveLength(1);
    expect(outcome.ok && outcome.data.derivativeBySceneId.get("s1")).toMatch(/^deriv-/);
  });

  it("fails with retryable MEDIA_PREPARE_FAILED when the worker never answers (timeout) — no fallback", async () => {
    const { store, service } = await setup(() => "silent");
    const before = store.rows.size;
    const outcome = await service.prepare(projectId, "user-1", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true }]);
    expect(outcome).toMatchObject({ ok: false, code: "MEDIA_PREPARE_FAILED", retryable: true });
    expect(outcome.ok === false && outcome.message).toContain("RESULT_TIMEOUT");
    expect(store.rows.size).toBe(before);
  }, 10_000);

  it("maps a retryable worker error to MEDIA_PREPARE_FAILED and a non-retryable one to VALIDATION_FAILED", async () => {
    const retry = await setup((job) => failedClipResult(job, "FFMPEG_FAILED", true));
    expect(await retry.service.prepare(projectId, "u", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true }])).toMatchObject({ ok: false, code: "MEDIA_PREPARE_FAILED", retryable: true });
    const bad = await setup((job) => failedClipResult(job, "RANGE_OUT_OF_BOUNDS", false));
    const outcome = await bad.service.prepare(projectId, "u", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true }]);
    expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED", retryable: false });
    expect(outcome.ok === false && outcome.message).toContain("RANGE_OUT_OF_BOUNDS");
  });

  it("rejects an output that still has audio when stripping was required", async () => {
    const { service } = await setup((job) => okClipResult(job, { hasAudio: true }));
    expect(await service.prepare(projectId, "u", [{ sceneId: "s1", parentMediaAssetVersionId: apifyParent.id, startMs: 0, durationMs: 3000, stripAudio: true }])).toMatchObject({ ok: false, code: "MEDIA_PREPARE_FAILED" });
  });

  it("returns PROVIDER_NOT_CONFIGURED when the media worker is not configured (no RABBITMQ_URL)", async () => {
    const store = mediaAssetStore([pexelsParent]);
    const preparer = { prepareClip: vi.fn(async () => { throw new MediaJobClientError("MEDIA_WORKER_NOT_CONFIGURED", "no url"); }) };
    const service = new ClipDerivativesService({ mediaAssetVersion: store } as never, preparer);
    service.log = () => undefined;
    expect(await service.prepare(projectId, "u", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true }])).toMatchObject({ ok: false, code: "PROVIDER_NOT_CONFIGURED", retryable: false });
  });

  it("reports a client-side INVALID_JOB validation reason without suggesting a retry", async () => {
    const store = mediaAssetStore([pexelsParent]);
    const preparer = { prepareClip: vi.fn(async () => { throw new MediaJobClientError("INVALID_JOB", "cropPlan.keyframes[0].tMs must start at 0 and strictly increase"); }) };
    const service = new ClipDerivativesService({ mediaAssetVersion: store } as never, preparer);
    service.log = () => undefined;
    const outcome = await service.prepare(projectId, "u", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true }]);
    expect(outcome).toMatchObject({ ok: false, code: "VALIDATION_FAILED", retryable: false });
    expect(!outcome.ok && outcome.message).toContain("cropPlan.keyframes[0].tMs");
  });

  it("rejects ranges on non-video media and on assets outside the project", async () => {
    const { worker, service } = await setup();
    expect(await service.prepare(projectId, "u", [{ sceneId: "s1", parentMediaAssetVersionId: imageParent.id, startMs: 0, durationMs: 3000, stripAudio: true }])).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await service.prepare("other-project", "u", [{ sceneId: "s1", parentMediaAssetVersionId: pexelsParent.id, startMs: 0, durationMs: 3000, stripAudio: true }])).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(worker.jobs).toHaveLength(0);
  });
});
