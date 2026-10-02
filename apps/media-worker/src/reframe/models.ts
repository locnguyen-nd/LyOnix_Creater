import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { MediaJobError } from "../job-errors.js";

/**
 * VE2E-66 detector models. They live OUTSIDE git under `data/models/` (env REFRAME_MODELS_DIR) and are fetched by
 * `pnpm --filter @lyonix/media-worker models:download`, which verifies the SHA-256 below. All three come from the OpenCV Zoo
 * (https://github.com/opencv/opencv_zoo) and are MIT / Apache-2.0. YOLOv8/Ultralytics is deliberately NOT used (AGPL-3.0).
 * A missing or corrupt model makes the job fail with MODEL_NOT_AVAILABLE; nothing silently degrades to a weaker detector.
 */

export type ReframeModelKey = "face" | "person" | "text";

export type ReframeModelSpec = {
  key: ReframeModelKey;
  file: string;
  sha256: string;
  bytes: number;
  license: string;
  source: string;
  url: string;
};

const ZOO_RAW = "https://github.com/opencv/opencv_zoo/raw/main/models";

export const REFRAME_MODELS: Record<ReframeModelKey, ReframeModelSpec> = {
  face: {
    key: "face",
    file: "face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    bytes: 232_589,
    license: "MIT (YuNet, ShiqiYu/libfacedetection.train; OpenCV Zoo)",
    source: "opencv_zoo/models/face_detection_yunet",
    url: `${ZOO_RAW}/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
  },
  person: {
    key: "person",
    file: "object_detection_yolox_2022nov.onnx",
    sha256: "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063",
    bytes: 35_858_002,
    license: "Apache-2.0 (YOLOX, Megvii-BaseDetection; OpenCV Zoo)",
    source: "opencv_zoo/models/object_detection_yolox",
    url: `${ZOO_RAW}/object_detection_yolox/object_detection_yolox_2022nov.onnx`,
  },
  text: {
    key: "text",
    file: "text_detection_cn_ppocrv3_2023may.onnx",
    sha256: "03f550c6b406fda8bf54bd8327815f6c7e2edd98cea02348c93d879254366587",
    bytes: 2_423_490,
    license: "Apache-2.0 (PP-OCRv3 DB detector, PaddlePaddle/PaddleOCR; OpenCV Zoo)",
    source: "opencv_zoo/models/text_detection_ppocr",
    url: `${ZOO_RAW}/text_detection_ppocr/text_detection_cn_ppocrv3_2023may.onnx`,
  },
};

export const sha256OfFile = (path: string): Promise<string> =>
  new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", rejectPromise)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });

const verified = new Map<string, string>();

/**
 * Resolves the absolute model paths, checking presence + size on every call and the SHA-256 once per (path,size,mtime) per process.
 * Throws `MediaJobError("MODEL_NOT_AVAILABLE")` listing every problem and the command that fixes it.
 */
export async function resolveReframeModels(modelsDir: string, keys: readonly ReframeModelKey[] = ["face", "person", "text"], specs: Record<ReframeModelKey, ReframeModelSpec> = REFRAME_MODELS): Promise<Record<ReframeModelKey, string>> {
  const paths = {} as Record<ReframeModelKey, string>;
  const problems: string[] = [];
  for (const key of keys) {
    const spec = specs[key];
    const path = join(modelsDir, spec.file);
    const info = await stat(path).catch(() => null);
    if (!info || !info.isFile()) {
      problems.push(`${spec.file} is missing`);
      continue;
    }
    if (info.size !== spec.bytes) {
      problems.push(`${spec.file} has ${info.size} bytes, expected ${spec.bytes}`);
      continue;
    }
    const cacheKey = `${path}:${info.size}:${info.mtimeMs}`;
    let digest = verified.get(cacheKey);
    if (!digest) {
      digest = await sha256OfFile(path);
      if (digest === spec.sha256) verified.set(cacheKey, digest);
    }
    if (digest !== spec.sha256) {
      problems.push(`${spec.file} checksum mismatch (got ${digest.slice(0, 12)}..., expected ${spec.sha256.slice(0, 12)}...)`);
      continue;
    }
    paths[key] = path;
  }
  if (problems.length > 0) {
    throw new MediaJobError(
      "MODEL_NOT_AVAILABLE",
      `reframe detector models unavailable in ${modelsDir}: ${problems.join("; ")}. Run "corepack pnpm --filter @lyonix/media-worker models:download" (or set REFRAME_MODELS_DIR).`,
    );
  }
  return paths;
}

export const reframeModelVersions = (): Record<string, string> =>
  Object.fromEntries(Object.values(REFRAME_MODELS).map((m) => [m.key, `${m.file}@${m.sha256.slice(0, 12)}`]));
