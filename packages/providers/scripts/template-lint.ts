/**
 * VE2E-117: `pnpm template:lint -- <template.json | dir> [...] [--json]`
 * Reads Creatomate/Orshot template JSON files, lists their fonts / transitions / animations / slots and marks what the internal `lyonix` engine
 * supports: group A (renderable internally) or B (provider-only). Exit code 2 when a file cannot be read as JSON; B is not an error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { formatLintReport, lintTemplate } from "../src/template-lint.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const asJson = args.includes("--json");
const inputs = args.filter((a) => !a.startsWith("--"));
if (inputs.length === 0) {
  console.error("usage: template-lint.ts <template.json | directory> [...] [--json]");
  process.exit(2);
}
// `pnpm template:lint` runs inside the package directory: relative inputs are relative to where the user typed the command
const baseDir = process.env.INIT_CWD || process.cwd();
const files: string[] = [];
for (const input of inputs) {
  const path = resolve(baseDir, input);
  if (!existsSync(path)) {
    console.error(`not found: ${input}`);
    process.exit(2);
  }
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) if (name.endsWith(".json")) files.push(join(path, name));
  } else {
    files.push(path);
  }
}
let failed = false;
const results: Array<{ file: string; report: ReturnType<typeof lintTemplate> }> = [];
for (const file of [...new Set(files)]) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    // a saved Creatomate `get_template` response wraps the RenderScript in `source`
    const source = typeof raw === "object" && raw !== null && "source" in raw && typeof (raw as { source: unknown }).source === "object" ? (raw as { source: unknown }).source : raw;
    results.push({ file, report: lintTemplate(source) });
  } catch (error) {
    failed = true;
    console.error(`${basename(file)}: cannot read as JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}
if (asJson) console.info(JSON.stringify(results.map(({ file, report }) => ({ file: basename(file), group: report.group, ...report })), null, 2));
else for (const { file, report } of results) console.info(`${formatLintReport(basename(file), report)}\n`);
const counts = results.reduce((acc, { report }) => ({ ...acc, [report.group]: (acc[report.group] ?? 0) + 1 }), {} as Record<string, number>);
if (!asJson) console.info(`group A (internal engine): ${counts.A ?? 0} · group B (provider-only): ${counts.B ?? 0}`);
process.exit(failed ? 2 : 0);
