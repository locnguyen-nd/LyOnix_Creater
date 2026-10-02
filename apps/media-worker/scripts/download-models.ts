/**
 * VE2E-66: downloads the reframe detector models into REFRAME_MODELS_DIR (default <repo>/data/models, git-ignored), verifying the
 * SHA-256 pinned in src/reframe/models.ts, and writes MODELS-LICENSES.txt next to them. Idempotent: a file that already has the right
 * checksum is skipped. Needs internet access to github.com once; the worker itself never downloads anything.
 *
 *   corepack pnpm --filter @lyonix/media-worker models:download
 */
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REFRAME_MODELS, sha256OfFile } from "../src/reframe/models.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const raw = process.env.REFRAME_MODELS_DIR?.trim() || "./data/models";
const modelsDir = isAbsolute(raw) ? raw : resolve(repoRoot, raw);

const main = async () => {
  await mkdir(modelsDir, { recursive: true });
  for (const spec of Object.values(REFRAME_MODELS)) {
    const target = join(modelsDir, spec.file);
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size === spec.bytes && (await sha256OfFile(target)) === spec.sha256) {
      console.info(`ok      ${spec.file} (already present, checksum verified)`);
      continue;
    }
    console.info(`fetch   ${spec.file} <- ${spec.url}`);
    const response = await fetch(spec.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${spec.url} -> HTTP ${response.status}`);
    const tmp = `${target}.part`;
    await writeFile(tmp, Buffer.from(await response.arrayBuffer()));
    const digest = await sha256OfFile(tmp);
    if (digest !== spec.sha256) {
      await rm(tmp, { force: true });
      throw new Error(`${spec.file}: checksum mismatch (got ${digest}, expected ${spec.sha256}); not installed`);
    }
    await rename(tmp, target);
    console.info(`ok      ${spec.file} (${spec.bytes} bytes, sha256 verified)`);
  }
  const lines = Object.values(REFRAME_MODELS).map((m) => `${m.file}\n  sha256  ${m.sha256}\n  license ${m.license}\n  source  ${m.source}\n  url     ${m.url}\n`);
  await writeFile(join(modelsDir, "MODELS-LICENSES.txt"), `LyOnix reframe detector models (VE2E-66). YOLOv8/Ultralytics (AGPL-3.0) is deliberately not used.\n\n${lines.join("\n")}`);
  console.info(`done: ${modelsDir}`);
};

main().catch((error) => {
  console.error(`models:download failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
