import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { buildFrameExtractJobKey, MediaJobClientError, type FrameExtractJobInput } from "@lyonix/media-jobs";
import { MAX_MODERATION_FRAMES, type VisionModerationFrame } from "@lyonix/providers";
import { mediaRoot } from "./handoff-workspace.js";
import { MediaJobsGateway, type FrameExtractor } from "./media-jobs.gateway.js";
import { PrismaService } from "./prisma.service.js";

/** VE2E-30: frames sampled per video (never above what one moderation call accepts). Env `VISION_VIDEO_FRAME_COUNT`, default 3. */
export const DEFAULT_VIDEO_FRAME_COUNT = 3;
export const videoFrameCount = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = Number(env.VISION_VIDEO_FRAME_COUNT);
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_MODERATION_FRAMES) : DEFAULT_VIDEO_FRAME_COUNT;
};

/** Env `VISION_VIDEO_FRAMES=1` turns on post-import frame moderation of imported videos (default OFF: it spends vision calls). */
export const visionVideoFramesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|on|yes)$/i.test((env.VISION_VIDEO_FRAMES ?? "").trim());

const FRAMES_DIR_PREFIX = "working/media-jobs/";

export type VideoFramesOutcome =
  | { ok: true; frames: VisionModerationFrame[]; reused: boolean; skippedFrames: number }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * VE2E-30: turns a stored video asset into the already-extracted JPEG frames the vision-moderation pipeline takes
 * (`moderateSceneCandidate` accepts frame bytes, it never extracts them). The FFmpeg work happens only in
 * `apps/media-worker` via the `frame.extract` job (never in this process); frames are `working` data with the 7-day TTL.
 * Best-effort by design: every failure is an `ok: false` outcome the caller treats as "no extra evidence", never a throw.
 */
@Injectable()
export class VideoFramesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MediaJobsGateway) private readonly extractor: FrameExtractor,
  ) {}

  async framesForAsset(mediaAssetVersionId: string, options: { frameCount?: number; windowStartMs?: number | null; windowDurationMs?: number | null; timeoutMs?: number; /** VE2E-152: low-res frames for the cleanliness check. */ maxWidth?: number } = {}): Promise<VideoFramesOutcome> {
    const asset = await this.prisma.mediaAssetVersion.findFirst({ where: { id: mediaAssetVersionId, deletedAt: null }, select: { id: true, kind: true, relativePath: true } });
    if (!asset || asset.kind !== "video") return { ok: false, code: "NOT_A_VIDEO", message: "Asset không phải video để lấy khung hình", retryable: false };
    const frameCount = options.frameCount ?? videoFrameCount();
    const job: FrameExtractJobInput = {
      jobKey: buildFrameExtractJobKey({ sourceMediaAssetVersionId: asset.id, frameCount, windowStartMs: options.windowStartMs ?? null, windowDurationMs: options.windowDurationMs ?? null, ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}) }),
      source: { relativePath: asset.relativePath, mediaAssetVersionId: asset.id },
      frameCount,
      windowStartMs: options.windowStartMs ?? null,
      windowDurationMs: options.windowDurationMs ?? null,
      ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
    };
    let result;
    try {
      result = await this.extractor.extractFrames(job, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {});
    } catch (error) {
      const code = error instanceof MediaJobClientError ? error.code : "MEDIA_WORKER_ERROR";
      return { ok: false, code, message: error instanceof Error ? error.message : "media worker error", retryable: true };
    }
    if (!result.ok) return { ok: false, code: result.error.code, message: result.error.message, retryable: result.error.retryable };
    const root = mediaRoot();
    const frames: VisionModerationFrame[] = [];
    for (const frame of result.frames.slice(0, MAX_MODERATION_FRAMES)) {
      // The worker only writes under working/media-jobs/; anything else (or a traversal) is ignored, never read.
      if (!frame.relativePath.startsWith(FRAMES_DIR_PREFIX) || frame.relativePath.split("/").includes("..")) continue;
      try {
        const bytes = await readFile(join(root, frame.relativePath));
        if (bytes.length === 0) continue;
        frames.push({ mimeType: frame.mimeType, base64: bytes.toString("base64") });
      } catch {
        // an expired/swept frame is just missing evidence
      }
    }
    if (frames.length === 0) return { ok: false, code: "NO_FRAMES", message: "Không đọc được khung hình nào đã trích", retryable: true };
    return { ok: true, frames, reused: result.reused, skippedFrames: result.skippedFrames };
  }
}
