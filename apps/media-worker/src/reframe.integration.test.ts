import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReframeAnalyzeJob } from "@lyonix/media-jobs";
import type { ExclusionRegion } from "@lyonix/domain";
import { runProcess } from "./process.js";
import { ReframeAnalyzeProcessor } from "./reframe-analyze.js";
import { loadReframeConfig } from "./reframe/config.js";
import type { FrameDetector } from "./reframe/detector.js";
import { encodeRgbToJpeg } from "./reframe/image-io.js";
import { REFRAME_MODELS } from "./reframe/models.js";
import { OnnxFrameDetector } from "./reframe/onnx-detector.js";

/**
 * VE2E-66 integration on tiny generated fixtures (nothing committed, no provider, no network):
 *  - REAL FFmpeg samples frames from a lavfi clip, a scripted detector places a subject, `planReframe` follows it;
 *  - REAL onnxruntime + the REAL PP-OCRv3 model find synthetic "text" (glyph-like blocks) in a still image.
 * Skipped with a clear message when FFmpeg or the downloaded models are missing (run `models:download`).
 * This proves wiring and the detector pre/post-processing, NOT quality on real TikTok/news footage (that is VE2E-69).
 */
const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const ffmpegOk = !spawnSync(ffmpegPath, ["-hide_banner", "-version"]).error && !spawnSync(ffprobePath, ["-hide_banner", "-version"]).error;
const repoRoot = resolve(import.meta.dirname, "../../..");
const modelsRaw = process.env.REFRAME_MODELS_DIR?.trim() || "./data/models";
const modelsDir = isAbsolute(modelsRaw) ? modelsRaw : resolve(repoRoot, modelsRaw);
const modelsOk = Object.values(REFRAME_MODELS).every((m) => existsSync(join(modelsDir, m.file)));
if (!ffmpegOk) console.warn("[media-worker] SKIPPING reframe FFmpeg integration: ffmpeg/ffprobe not runnable");
if (!modelsOk) console.warn(`[media-worker] SKIPPING reframe ONNX integration: models missing in ${modelsDir} (run "corepack pnpm --filter @lyonix/media-worker models:download")`);

let mediaRoot: string;
beforeAll(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), "reframe-int-"));
  await mkdir(join(mediaRoot, "projects/p/assets"), { recursive: true });
});
afterAll(async () => { await rm(mediaRoot, { recursive: true, force: true }); });

const cfg = () => ({ mediaRoot, ffmpegPath, ffprobePath, jobTimeoutMs: 60_000, maxAttempts: 1 });

describe.skipIf(!ffmpegOk)("reframe.analyze with real FFmpeg and a scripted detector", () => {
  it("samples a landscape lavfi clip and pans the 9:16 window with a subject walking left to right", async () => {
    const out = join(mediaRoot, "projects/p/assets/landscape.mp4");
    const gen = spawnSync(ffmpegPath, ["-hide_banner", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=8", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", out], { encoding: "utf8" });
    if (gen.status !== 0) throw new Error(`fixture failed: ${gen.stderr}`);
    // Subject walks from the left edge to the right edge in small steps (frame is 448 wide here), so it stays ONE track.
    let call = 0;
    const detector: FrameDetector = {
      runtime: "scripted",
      async detectFaces(image) {
        call += 1;
        return [{ box: { x: 40 + (call - 1) * 55, y: image.height * 0.2, w: 50, h: 60 }, score: 0.95 }];
      },
      async detectPersons() { return []; },
      async detectText() { return []; },
      async close() {},
    };
    const processor = new ReframeAnalyzeProcessor({ config: cfg(), reframe: loadReframeConfig({ REFRAME_MODELS_DIR: "/none" }, repoRoot, 4), runner: runProcess, ffmpegVersion: "int", detector });
    const result = await processor.handle(buildReframeAnalyzeJob({ jobKey: "reframe:int-ffmpeg", source: { relativePath: "projects/p/assets/landscape.mp4" } }));
    expect(result).toMatchObject({ ok: true, source: { width: 640, height: 360 } });
    if (!result.ok) throw new Error("unreachable");
    expect(result.analysis.framesSampled).toBeGreaterThanOrEqual(5);
    expect(result.analysis.subjectSource).toBe("face");
    const xs = result.cropPlan.keyframes.map((k) => k.xPx);
    expect(result.cropPlan.keyframes.every((k) => k.heightPx <= 360 && Math.abs(k.widthPx / k.heightPx - 9 / 16) < 0.01)).toBe(true);
    expect(xs[0]!).toBeLessThan(xs[xs.length - 1]!); // the window moved right with the subject
  }, 120_000);
});

describe.skipIf(!ffmpegOk || !modelsOk)("reframe.analyze with real FFmpeg + real ONNX models on a synthetic still", () => {
  it("finds two lines of glyph-like text in a still and turns them into text exclusions", async () => {
    const w = 320;
    const h = 240;
    const data = new Uint8Array(w * h * 3).fill(30);
    for (const [y0, n] of [[60, 14], [120, 10]] as const) {
      for (let g = 0; g < n; g += 1) {
        const x0 = 40 + g * 18;
        for (let y = 0; y < 18; y += 1) {
          for (let x = 0; x < 11; x += 1) {
            if (x < 3 || x > 7 || y < 3 || y > 14 || y === 8) data.fill(245, ((y0 + y) * w + x0 + x) * 3, ((y0 + y) * w + x0 + x) * 3 + 3);
          }
        }
      }
    }
    await writeFile(join(mediaRoot, "projects/p/assets/text.jpg"), encodeRgbToJpeg({ width: w, height: h, data }, 95));
    const detector = new OnnxFrameDetector({ modelsDir, threads: 1 });
    let exclusions: ExclusionRegion[] = [];
    const reframe = loadReframeConfig({ REFRAME_MODELS_DIR: modelsDir, REFRAME_TEXT_TOP_PCT: "50", REFRAME_TEXT_BOTTOM_PCT: "50" }, repoRoot, 4);
    const processor = new ReframeAnalyzeProcessor({ config: cfg(), reframe, runner: runProcess, ffmpegVersion: "int", detector, onDebug: ({ debug }) => { exclusions = debug.exclusions; } });
    try {
      const result = await processor.handle(buildReframeAnalyzeJob({ jobKey: "reframe:int-onnx", source: { relativePath: "projects/p/assets/text.jpg", kind: "image" } }));
      expect(result).toMatchObject({ ok: true, window: { durationMs: 0 }, cropPlan: { mode: "static" }, tool: { detectorRuntime: "onnxruntime-node" } });
      if (!result.ok) throw new Error("unreachable");
      expect(result.analysis.framesWithFace).toBe(0);
      const text = exclusions.filter((e) => e.kind === "text");
      expect(text.length).toBeGreaterThanOrEqual(2);
      // Ground truth in the 320x240 source: line 1 spans x 40..285, y 60..78; line 2 spans x 40..211, y 120..138. Frame is small enough to be unscaled.
      const covers = (gt: { x0: number; y0: number; x1: number; y1: number }) => text.some((e) => e.box.xPx <= gt.x0 + 12 && e.box.yPx <= gt.y0 + 6 && e.box.xPx + e.box.widthPx >= gt.x1 - 12 && e.box.yPx + e.box.heightPx >= gt.y1 - 6);
      expect(covers({ x0: 40, y0: 60, x1: 285, y1: 78 })).toBe(true);
      expect(covers({ x0: 40, y0: 120, x1: 211, y1: 138 })).toBe(true);
    } finally {
      await detector.close();
    }
  }, 120_000);
});
