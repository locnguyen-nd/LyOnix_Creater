/**
 * VE2E-112 dev/test tool: runs ONE `video.compose` job through the real ComposeProcessor (the same code the worker runs on lyonix.render) with
 * the real FFmpeg, without RabbitMQ. Used by the API's Auto end-to-end test and handy for local A/B work.
 *
 *   tsx scripts/compose-cli.ts --media-root <dir> --job <job.json> [--font "Noto Sans JP"] [--preset veryfast]
 *
 * `--font` substitutes every font family of the released recipes (e.g. a machine without Noto Sans CJK JP); never use it to hide a missing font in
 * production. Prints the result as one JSON line on stdout; exit code 0 even for `ok: false` (the result says why), 2 for usage errors.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASED_RECIPES, RecipeRegistry, type RenderRecipe } from "@lyonix/render-recipes";
import { loadComposeConfig } from "../src/compose/config.js";
import { ComposeProcessor } from "../src/compose/compose-processor.js";
import { readToolVersion, runProcess } from "../src/process.js";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const mediaRoot = arg("media-root");
const jobFile = arg("job");
if (!mediaRoot || !jobFile) {
  console.error("usage: compose-cli.ts --media-root <dir> --job <job.json> [--font <family>] [--preset <x264 preset>]");
  process.exit(2);
}
const font = arg("font");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const withFont = (recipe: RenderRecipe): RenderRecipe => {
  if (!font) return recipe;
  const copy = structuredClone(recipe);
  copy.captions.fontFamily = font;
  copy.fonts = [font];
  for (const layer of copy.layers) if (layer.type === "text") layer.fontFamily = font;
  return copy;
};

const ffmpegPath = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH?.trim() || "ffprobe";
const compose = loadComposeConfig({ ...process.env, ...(arg("preset") ? { RENDER_X264_PRESET: arg("preset")! } : {}) }, repoRoot);
const processor = new ComposeProcessor({
  config: { mediaRoot: resolve(mediaRoot), ffmpegPath, ffprobePath, maxAttempts: 1 },
  compose,
  runner: runProcess,
  ffmpegVersion: await readToolVersion(runProcess, ffmpegPath),
  recipes: new RecipeRegistry(RELEASED_RECIPES.map(withFont)),
  log: (message) => console.error(`[compose-cli] ${message}`),
});
const result = await processor.handle(JSON.parse(readFileSync(resolve(jobFile), "utf8")));
process.stdout.write(`${JSON.stringify(result)}\n`);
