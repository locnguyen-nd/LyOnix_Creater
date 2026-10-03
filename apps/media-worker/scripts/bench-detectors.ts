/**
 * VE2E-66/70/71 measurement tool (not run in CI): times each local detector on JPEG frames and prints RSS after each model load.
 *
 *   REFRAME_MODELS_DIR=... tsx scripts/bench-detectors.ts <dir-with-jpegs> [threads]
 */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { decodeJpegToRgb } from "../src/reframe/image-io.js";
import { OnnxFrameDetector } from "../src/reframe/onnx-detector.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bench-detectors.ts <dir-with-jpegs> [threads]");
  process.exit(2);
}
const threads = Number(process.argv[3] ?? 1);
const raw = process.env.REFRAME_MODELS_DIR?.trim() || "./data/models";
const modelsDir = isAbsolute(raw) ? raw : resolve(process.cwd(), "../..", raw);
const detector = new OnnxFrameDetector({ modelsDir, threads });
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
console.info(`threads=${threads} rss(start)=${rss()}MB`);
for (const key of ["face", "person", "text"] as const) {
  await detector.warmUp([key]);
  console.info(`rss(after loading ${key})=${rss()}MB`);
}
const times: Record<string, number[]> = { face: [], person: [], text: [] };
const fmt = (found: Array<{ box: { x: number; y: number; w: number; h: number }; score: number }>) =>
  found.slice(0, 3).map((d) => `${Math.round(d.box.x)},${Math.round(d.box.y)},${Math.round(d.box.w)}x${Math.round(d.box.h)}@${d.score.toFixed(2)}`).join(" | ");
for (const file of readdirSync(dir).filter((n) => n.endsWith(".jpg")).sort()) {
  const image = decodeJpegToRgb(readFileSync(join(dir, file)));
  const out: Record<string, number> = {};
  const lines: string[] = [];
  for (const [key, run] of [
    ["face", () => detector.detectFaces(image)],
    ["person", () => detector.detectPersons(image)],
    ["text", () => detector.detectText(image)],
  ] as const) {
    await run(); // warm-up pass, not timed
    const start = performance.now();
    const found = await run();
    times[key]!.push(performance.now() - start);
    out[key] = found.length;
    lines.push(`${key}=${found.length} ${fmt(found)}`);
  }
  console.info(`${file} ${image.width}x${image.height}  ${lines.join("  ")}`);
}
for (const [key, values] of Object.entries(times)) {
  const sorted = [...values].sort((a, b) => a - b);
  console.info(`${key}: median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(0)} ms, max ${sorted.at(-1)?.toFixed(0)} ms over ${sorted.length} frames`);
}
console.info(`rss(end)=${rss()}MB`);
await detector.close();
