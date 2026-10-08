/**
 * VE2E-149 live probe of the open-source download path (CR-MEDIA-OSS-FETCH §3.6): runs the REAL SocialFetchProcessor (the code the worker runs
 * on lyonix.media.fetch) with the installed yt-dlp / gallery-dl, without RabbitMQ / DB. Measures, per platform: success rate, 403 / bot-check /
 * cookies rate, the recovery steps used, and download time. Every downloaded file is deleted at the end (nothing is kept or registered).
 *
 *   tsx scripts/fetch-probe.ts --urls <file>          one "<platform> <post-url>" per line (# comments allowed)
 *   tsx scripts/fetch-probe.ts --search youtube "メッシ 引退" [--limit 5]     search, then download the results
 *   options: --cookies <cookies.txt> (Netscape, copied into a private temp dir), --proxy (use MEDIA_FETCH_PROXY), --json, --keep
 *
 * Output never contains cookie values or signed CDN URLs (results are redacted by the processor). Exit 0 even when downloads fail
 * (the report says why), 2 on usage errors.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMediaFetchJob, buildMediaFetchJobKey, buildMediaSearchJob, buildMediaSearchJobKey, isSocialFetchPlatform, MEDIA_FETCH_COOKIES_DIR, type SocialFetchPlatform } from "@lyonix/media-jobs";
import { runProcess } from "../src/process.js";
import { loadSocialFetchConfig } from "../src/social-fetch/config.js";
import { SocialFetchProcessor } from "../src/social-fetch/processor.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const usage = (message: string): never => {
  console.error(`${message}\nusage: fetch-probe.ts --urls <file> | --search <youtube|pinterest|x> "<query>" [--limit N] [--cookies <file>] [--proxy] [--json] [--keep]`);
  process.exit(2);
};

const toolFor = (platform: SocialFetchPlatform, mediaType: "video" | "image") => (mediaType === "image" || platform === "pinterest" ? "gallery-dl" : "yt-dlp") as "yt-dlp" | "gallery-dl";
const percentile = (values: number[], q: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
};

const main = async () => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "lyonix-fetch-probe-"));
  const fetchCfg = loadSocialFetchConfig(process.env);
  const processor = new SocialFetchProcessor({ config: { mediaRoot, ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg", ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe" }, fetch: fetchCfg, runner: runProcess });
  let cookiesRelativePath: string | null = null;
  const cookies = arg("cookies");
  if (cookies) {
    await mkdir(join(mediaRoot, MEDIA_FETCH_COOKIES_DIR), { recursive: true, mode: 0o700 });
    cookiesRelativePath = `${MEDIA_FETCH_COOKIES_DIR}/probe.txt`;
    await copyFile(cookies, join(mediaRoot, cookiesRelativePath));
  }
  const useProxy = flag("proxy");
  if (useProxy && !fetchCfg.proxyUrl) usage("--proxy needs MEDIA_FETCH_PROXY");

  const targets: Array<{ platform: SocialFetchPlatform; url: string; mediaType: "video" | "image" }> = [];
  const searches: Array<{ platform: string; query: string; ok: boolean; items: number; code: string | null; ms: number }> = [];
  const urlsFile = arg("urls");
  const search = arg("search");
  if (urlsFile) {
    for (const line of (await readFile(urlsFile, "utf8")).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const [platform, url] = t.split(/\s+/);
      if (!isSocialFetchPlatform(platform) || !url) usage(`bad line: ${t}`);
      targets.push({ platform: platform as SocialFetchPlatform, url: url!, mediaType: platform === "pinterest" ? "image" : "video" });
    }
  } else if (search) {
    if (!isSocialFetchPlatform(search) || search === "tiktok" || search === "instagram") usage("--search supports youtube | pinterest | x");
    const query = argv[argv.indexOf("--search") + 2];
    if (!query || query.startsWith("--")) usage("missing search query");
    const limit = Math.min(30, Math.max(1, Number(arg("limit") ?? 5) || 5));
    const mediaType = search === "youtube" ? "video" : "image";
    const tool = toolFor(search as SocialFetchPlatform, mediaType);
    const started = Date.now();
    const result = await processor.handleSearch(buildMediaSearchJob({ jobKey: buildMediaSearchJobKey({ platform: search as SocialFetchPlatform, tool, query: query!, limit }), platform: search as SocialFetchPlatform, tool, query: query!, limit, mediaType, cookiesRelativePath, useProxy }));
    searches.push({ platform: search, query: query!, ok: result.ok, items: result.ok ? result.items.length : 0, code: result.ok ? null : result.error.code, ms: Date.now() - started });
    if (result.ok) for (const item of result.items) targets.push({ platform: search as SocialFetchPlatform, url: item.url, mediaType });
  } else usage("give --urls or --search");

  const rows: Array<{ platform: string; ok: boolean; code: string | null; steps: string; ms: number; bytes: number; width: number | null; height: number | null; durationMs: number | null }> = [];
  for (const target of targets) {
    const tool = toolFor(target.platform, target.mediaType);
    const started = Date.now();
    const result = await processor.handleFetch(buildMediaFetchJob({ jobKey: buildMediaFetchJobKey({ platform: target.platform, url: target.url }), platform: target.platform, tool, url: target.url, mediaType: target.mediaType, cookiesRelativePath, useProxy }));
    const ms = Date.now() - started;
    rows.push({
      platform: target.platform,
      ok: result.ok,
      code: result.ok ? null : result.error.code,
      steps: (result.attempts ?? []).map((a) => `${a.step}${a.code ? `:${a.code}` : ""}`).join(">"),
      ms,
      bytes: result.ok ? result.bytes : 0,
      width: result.ok ? result.probe?.width ?? null : null,
      height: result.ok ? result.probe?.height ?? null : null,
      durationMs: result.ok ? result.probe?.durationMs ?? null : null,
    });
    if (!flag("json")) console.log(`${result.ok ? "OK  " : "FAIL"} ${target.platform.padEnd(9)} ${String(ms).padStart(6)}ms ${rows.at(-1)!.steps || "-"} ${result.ok ? `${(result.bytes / 1e6).toFixed(1)}MB ${rows.at(-1)!.width ?? "?"}x${rows.at(-1)!.height ?? "?"}` : result.error.code}`);
  }

  const byPlatform: Record<string, { n: number; ok: number; blocked: number; p50Ms: number; p95Ms: number; codes: Record<string, number> }> = {};
  for (const platform of [...new Set(rows.map((r) => r.platform))]) {
    const list = rows.filter((r) => r.platform === platform);
    const okMs = list.filter((r) => r.ok).map((r) => r.ms);
    const codes: Record<string, number> = {};
    for (const r of list) if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
    byPlatform[platform] = {
      n: list.length,
      ok: list.filter((r) => r.ok).length,
      blocked: list.filter((r) => r.code && ["FETCH_FORBIDDEN", "FETCH_BOT_CHECK", "FETCH_COOKIES_INVALID", "FETCH_RATE_LIMITED"].includes(r.code)).length,
      p50Ms: percentile(okMs, 0.5),
      p95Ms: percentile(okMs, 0.95),
      codes,
    };
  }
  const report = { at: new Date().toISOString(), tools: { ytDlp: fetchCfg.ytDlpPath, galleryDl: fetchCfg.galleryDlPath }, cookies: Boolean(cookies), proxy: useProxy, searches, byPlatform, rows };
  if (flag("json")) console.log(JSON.stringify(report, null, 2));
  else {
    for (const s of searches) console.log(`search ${s.platform} "${s.query}": ${s.ok ? `${s.items} item(s)` : s.code} in ${s.ms}ms`);
    for (const [platform, p] of Object.entries(byPlatform)) console.log(`${platform}: ${p.ok}/${p.n} ok, blocked ${p.blocked}, p50 ${(p.p50Ms / 1000).toFixed(1)}s p95 ${(p.p95Ms / 1000).toFixed(1)}s ${JSON.stringify(p.codes)}`);
  }
  if (!flag("keep")) await rm(mediaRoot, { recursive: true, force: true });
  else console.error(`kept downloads under ${mediaRoot}`);
};

void main();
