import type { Detection, RgbImage } from "./image-io.js";

/**
 * What the analyzer needs from a detector runtime. The production implementation is `OnnxFrameDetector` (onnxruntime-node, same ONNX
 * models as the VE2E-64 spike). Tests inject a deterministic fake; there is NO silent fallback between runtimes.
 */
export interface FrameDetector {
  readonly runtime: string;
  /** Face boxes in image pixels. */
  detectFaces(image: RgbImage): Promise<Detection[]>;
  /** Person boxes in image pixels. */
  detectPersons(image: RgbImage): Promise<Detection[]>;
  /** Text boxes (already unclipped) in image pixels. */
  detectText(image: RgbImage): Promise<Detection[]>;
  close(): Promise<void>;
}
