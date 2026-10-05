import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REFRAME_MODELS, resolveReframeModels, type ReframeModelSpec } from "./models.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "reframe-models-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const specFor = (bytes: Buffer): Record<"face" | "person" | "text", ReframeModelSpec> => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const make = (key: "face" | "person" | "text"): ReframeModelSpec => ({ key, file: `${key}.onnx`, sha256, bytes: bytes.length, license: "test", source: "test", url: "http://localhost/x" });
  return { face: make("face"), person: make("person"), text: make("text") };
};

describe("resolveReframeModels", () => {
  it("pins SHA-256, size and a permissive licence for every model, none of them YOLOv8/AGPL", () => {
    for (const spec of Object.values(REFRAME_MODELS)) {
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.bytes).toBeGreaterThan(1000);
      expect(spec.license).toMatch(/MIT|Apache-2\.0/);
      expect(spec.file.toLowerCase()).not.toContain("yolov8");
    }
  });

  it("fails with MODEL_NOT_AVAILABLE naming the missing file and the download command", async () => {
    await expect(resolveReframeModels(dir)).rejects.toMatchObject({ code: "MODEL_NOT_AVAILABLE", retryable: false, message: expect.stringContaining("models:download") });
    await expect(resolveReframeModels(dir)).rejects.toThrow(/face_detection_yunet_2023mar\.onnx is missing/);
  });

  it("rejects a wrong size and a checksum mismatch, accepts a verified file", async () => {
    const bytes = Buffer.from("fake-onnx-bytes");
    const specs = specFor(bytes);
    await writeFile(join(dir, "face.onnx"), Buffer.from("short"));
    await expect(resolveReframeModels(dir, ["face"], specs)).rejects.toThrow(/expected 15/);
    await writeFile(join(dir, "face.onnx"), Buffer.from("fake-onnx-BYTES")); // same length, other content
    await expect(resolveReframeModels(dir, ["face"], specs)).rejects.toThrow(/checksum mismatch/);
    await writeFile(join(dir, "face.onnx"), bytes);
    await expect(resolveReframeModels(dir, ["face"], specs)).resolves.toEqual({ face: join(dir, "face.onnx") });
  });
});
