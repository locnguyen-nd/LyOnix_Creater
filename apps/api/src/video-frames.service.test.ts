import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaJobClientError, type FrameExtractJobInput, type FrameExtractResult } from "@lyonix/media-jobs";
import { VideoFramesService, videoFrameCount, visionVideoFramesEnabled } from "./video-frames.service.js";

let root: string;
let prevRoot: string | undefined;

const success = (relativePaths: string[], reused = false): FrameExtractResult => ({
  schemaVersion: "media-job.v1",
  type: "frame.extract.result",
  ok: true,
  jobKey: "frames:x",
  reused,
  source: { relativePath: "projects/p/assets/v.mp4", mediaAssetVersionId: "asset-1", durationMs: 60_000, width: 720, height: 1280 },
  frames: relativePaths.map((relativePath, index) => ({ relativePath, mimeType: "image/jpeg" as const, atMs: index * 1000, width: 640, height: 360, bytes: 4, sha256: "0".repeat(64) })),
  skippedFrames: 0,
  retentionClass: "working",
  expiresAt: "2026-10-08T00:00:00.000Z",
  tool: { profileVersion: "frame-extract.v1", ffmpegVersion: "test" },
  completedAt: "2026-10-01T00:00:00.000Z",
});

const prismaWith = (asset: unknown) => ({ mediaAssetVersion: { findFirst: vi.fn(async () => asset) } }) as any;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lyonix-frames-api-"));
  prevRoot = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = root;
  await mkdir(join(root, "working/media-jobs/abc"), { recursive: true });
  await writeFile(join(root, "working/media-jobs/abc/frame-0.jpg"), Buffer.from([1, 2, 3, 4]));
  await writeFile(join(root, "working/media-jobs/abc/frame-1.jpg"), Buffer.from([5, 6, 7, 8]));
  await writeFile(join(root, "secret.txt"), "do not read");
});
afterEach(async () => {
  if (prevRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = prevRoot;
  await rm(root, { recursive: true, force: true });
});

describe("VideoFramesService", () => {
  const asset = { id: "asset-1", kind: "video", relativePath: "projects/p/assets/v.mp4" };

  it("asks the media worker for the frames and returns them as vision frames (base64 JPEG)", async () => {
    const extractor = { extractFrames: vi.fn(async (_job: FrameExtractJobInput) => success(["working/media-jobs/abc/frame-0.jpg", "working/media-jobs/abc/frame-1.jpg"])) };
    const outcome = await new VideoFramesService(prismaWith(asset), extractor).framesForAsset("asset-1");
    expect(outcome).toEqual({ ok: true, reused: false, skippedFrames: 0, frames: [{ mimeType: "image/jpeg", base64: Buffer.from([1, 2, 3, 4]).toString("base64") }, { mimeType: "image/jpeg", base64: Buffer.from([5, 6, 7, 8]).toString("base64") }] });
    const job = extractor.extractFrames.mock.calls[0]![0];
    expect(job).toMatchObject({ source: { relativePath: "projects/p/assets/v.mp4", mediaAssetVersionId: "asset-1" }, frameCount: 3 });
    expect(job.jobKey).toMatch(/^frames:[0-9a-f]{40}$/);
  });

  it("uses the same job key for the same asset and plan (idempotent retries), a different one for another plan", async () => {
    const keys: string[] = [];
    const extractor = { extractFrames: vi.fn(async (job: FrameExtractJobInput) => { keys.push(job.jobKey); return success(["working/media-jobs/abc/frame-0.jpg"]); }) };
    const service = new VideoFramesService(prismaWith(asset), extractor);
    await service.framesForAsset("asset-1");
    await service.framesForAsset("asset-1");
    await service.framesForAsset("asset-1", { frameCount: 2 });
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("refuses non-video or missing assets without calling the worker", async () => {
    const extractor = { extractFrames: vi.fn() };
    expect(await new VideoFramesService(prismaWith({ ...asset, kind: "image" }), extractor).framesForAsset("asset-1")).toMatchObject({ ok: false, code: "NOT_A_VIDEO" });
    expect(await new VideoFramesService(prismaWith(null), extractor).framesForAsset("nope")).toMatchObject({ ok: false, code: "NOT_A_VIDEO" });
    expect(extractor.extractFrames).not.toHaveBeenCalled();
  });

  it("never throws: a down worker or a failed job is an ok:false outcome (best-effort evidence)", async () => {
    const down = { extractFrames: vi.fn(async () => { throw new MediaJobClientError("BROKER_UNAVAILABLE", "rabbit down"); }) };
    expect(await new VideoFramesService(prismaWith(asset), down).framesForAsset("asset-1")).toMatchObject({ ok: false, code: "BROKER_UNAVAILABLE", retryable: true });
    const failed = { extractFrames: vi.fn(async (): Promise<FrameExtractResult> => ({ schemaVersion: "media-job.v1", type: "frame.extract.result", ok: false, jobKey: "k", error: { code: "NO_VIDEO_STREAM", message: "no video", retryable: false, attempts: 1 }, completedAt: "x" })) };
    expect(await new VideoFramesService(prismaWith(asset), failed).framesForAsset("asset-1")).toMatchObject({ ok: false, code: "NO_VIDEO_STREAM", retryable: false });
  });

  it("only reads frames under working/media-jobs/ (path escapes and foreign paths are ignored)", async () => {
    const extractor = { extractFrames: vi.fn(async () => success(["../secret.txt", "secret.txt", "working/media-jobs/../../secret.txt", "working/media-jobs/abc/frame-0.jpg"])) };
    const outcome = await new VideoFramesService(prismaWith(asset), extractor).framesForAsset("asset-1");
    expect(outcome.ok && outcome.frames).toHaveLength(1);
    const none = { extractFrames: vi.fn(async () => success(["../secret.txt"])) };
    expect(await new VideoFramesService(prismaWith(asset), none).framesForAsset("asset-1")).toMatchObject({ ok: false, code: "NO_FRAMES" });
  });
});

describe("frame-check settings", () => {
  it("is opt-in and bounds the frame count by what one moderation call accepts", () => {
    expect(visionVideoFramesEnabled({})).toBe(false);
    expect(visionVideoFramesEnabled({ VISION_VIDEO_FRAMES: "1" })).toBe(true);
    expect(visionVideoFramesEnabled({ VISION_VIDEO_FRAMES: "off" })).toBe(false);
    expect(videoFrameCount({})).toBe(3);
    expect(videoFrameCount({ VISION_VIDEO_FRAME_COUNT: "99" })).toBe(6);
    expect(videoFrameCount({ VISION_VIDEO_FRAME_COUNT: "2" })).toBe(2);
    expect(videoFrameCount({ VISION_VIDEO_FRAME_COUNT: "x" })).toBe(3);
  });
});
