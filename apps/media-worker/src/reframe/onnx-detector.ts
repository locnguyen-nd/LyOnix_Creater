import { MediaJobError } from "../job-errors.js";
import type { FrameDetector } from "./detector.js";
import { dbInputSize, dbTensor, decodeDbText } from "./dbtext.js";
import type { Detection, RgbImage } from "./image-io.js";
import { resolveReframeModels, type ReframeModelKey } from "./models.js";
import { decodeYoloxPersons, YOLOX_INPUT, yoloxLetterbox } from "./yolox.js";
import { decodeYunet, mergeYunetTiles, YUNET_INPUT, yunetTensor, yunetTiles } from "./yunet.js";

type OrtModule = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

export type OnnxDetectorOptions = {
  modelsDir: string;
  /** onnxruntime intra-op threads per session (keep low so parallel FFmpeg jobs are not starved). */
  threads: number;
  faceScoreThreshold?: number;
  personScoreThreshold?: number;
  /** Long side of the DB text input (multiple of 32 enforced). Higher = better small text, slower. */
  textMaxLongSide?: number;
};

/**
 * Local detectors on onnxruntime-node (CPU). Sessions are created lazily, once, and only for the models actually used. Any model
 * problem (missing file, checksum mismatch, runtime not loadable) is a MODEL_NOT_AVAILABLE job error, never a silent downgrade.
 */
export class OnnxFrameDetector implements FrameDetector {
  readonly runtime = "onnxruntime-node";
  private ort: OrtModule | null = null;
  private readonly sessions = new Map<ReframeModelKey, Promise<Session>>();

  constructor(private readonly options: OnnxDetectorOptions) {}

  private async loadOrt(): Promise<OrtModule> {
    if (this.ort) return this.ort;
    try {
      this.ort = await import("onnxruntime-node");
    } catch (error) {
      throw new MediaJobError("MODEL_NOT_AVAILABLE", `onnxruntime-node cannot be loaded (${error instanceof Error ? error.message.split("\n")[0] : "unknown"}); reinstall dependencies on this platform`);
    }
    return this.ort;
  }

  private session(key: ReframeModelKey): Promise<Session> {
    let pending = this.sessions.get(key);
    if (!pending) {
      pending = (async () => {
        const ort = await this.loadOrt();
        const paths = await resolveReframeModels(this.options.modelsDir, [key]);
        try {
          return await ort.InferenceSession.create(paths[key], {
            executionProviders: ["cpu"],
            intraOpNumThreads: Math.max(1, this.options.threads),
            interOpNumThreads: 1,
            graphOptimizationLevel: "all",
            logSeverityLevel: 3,
          });
        } catch (error) {
          throw new MediaJobError("MODEL_NOT_AVAILABLE", `cannot load model ${key}: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
        }
      })();
      this.sessions.set(key, pending);
      pending.catch(() => this.sessions.delete(key)); // let a later job retry after the operator fixes the model
    }
    return pending;
  }

  /** Eagerly loads the sessions (used by the CLI/bench and for a fail-fast preflight). */
  async warmUp(keys: readonly ReframeModelKey[] = ["face", "person", "text"]): Promise<void> {
    for (const key of keys) await this.session(key);
  }

  private async run<T>(key: ReframeModelKey, feeds: Record<string, import("onnxruntime-node").Tensor>, decode: (outputs: Record<string, { data: unknown }>) => T): Promise<T> {
    const session = await this.session(key);
    try {
      const outputs = await session.run(feeds);
      return decode(outputs as unknown as Record<string, { data: unknown }>);
    } catch (error) {
      if (error instanceof MediaJobError) throw error;
      throw new MediaJobError("DETECTOR_FAILED", `${key} detector failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`, true);
    }
  }

  async detectFaces(image: RgbImage): Promise<Detection[]> {
    const ort = await this.loadOrt();
    const threshold = this.options.faceScoreThreshold ?? 0.6;
    const tiles = yunetTiles(image.width, image.height);
    const perTile: Array<{ tile: (typeof tiles)[number]; detections: Detection[] }> = [];
    for (const tile of tiles) {
      const tensor = new ort.Tensor("float32", yunetTensor(image, tile), [1, 3, YUNET_INPUT, YUNET_INPUT]);
      const detections = await this.run("face", { input: tensor }, (out) => decodeYunet(out as unknown as Record<string, { data: Float32Array }>, threshold));
      perTile.push({ tile, detections });
    }
    return mergeYunetTiles(perTile, image.width, image.height);
  }

  async detectPersons(image: RgbImage): Promise<Detection[]> {
    const ort = await this.loadOrt();
    const { tensor, ratio } = yoloxLetterbox(image);
    const input = new ort.Tensor("float32", tensor, [1, 3, YOLOX_INPUT, YOLOX_INPUT]);
    return this.run("person", { images: input }, (out) =>
      decodeYoloxPersons(out.output!.data as Float32Array, ratio, image.width, image.height, this.options.personScoreThreshold ?? 0.35),
    );
  }

  async detectText(image: RgbImage): Promise<Detection[]> {
    const ort = await this.loadOrt();
    const { w, h } = dbInputSize(image.width, image.height, this.options.textMaxLongSide ?? 960);
    const input = new ort.Tensor("float32", dbTensor(image, w, h), [1, 3, h, w]);
    return this.run("text", { x: input }, (out) => decodeDbText(out["4"]!.data as Float32Array, w, h, image.width, image.height));
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const pending of sessions) {
      const session = await pending.catch(() => null);
      await session?.release().catch(() => undefined);
    }
  }
}
