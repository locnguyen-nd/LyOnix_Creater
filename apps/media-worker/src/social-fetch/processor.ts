import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MEDIA_FETCH_PROFILE_VERSION,
  MEDIA_FETCH_RESULT_TYPE,
  MEDIA_JOB_SCHEMA_VERSION,
  MEDIA_SEARCH_RESULT_TYPE,
  validateMediaFetchJob,
  validateMediaSearchJob,
  type MediaFetchAttempt,
  type MediaFetchAttemptStep,
  type MediaFetchErrorCode,
  type MediaFetchFailure,
  type MediaFetchJob,
  type MediaFetchResult,
  type MediaFetchSuccess,
  type MediaJobErrorCode,
  type MediaSearchFailure,
  type MediaSearchJob,
  type MediaSearchResult,
  type SocialFetchTool,
  type SocialMediaInfo,
  type SocialSearchItem,
} from "@lyonix/media-jobs";
import { buildProbeArgs, parseProbeJson } from "../clip-plan.js";
import { sha256File } from "../clip-prepare.js";
import { resolveMediaSource } from "../media-source.js";
import { BinaryNotFoundError, ProcessTimeoutError, type ProcessRunner } from "../process.js";
import {
  buildGalleryDlFetchArgs,
  buildGalleryDlSearchArgs,
  buildYtDlpFetchArgs,
  buildYtDlpSearchArgs,
  classifyFetchFailure,
  firstFetchStep,
  galleryInfo,
  gallerySearchUrl,
  impersonationUnavailable,
  lastJsonLine,
  nextFetchStep,
  parseGallerySearch,
  parseJsonKeepingBigIds,
  parseToolVersion,
  parseYtDlpSearch,
  redactCliText,
  ytdlpInfo,
  type CliAccess,
} from "./cli.js";
import type { SocialFetchConfig } from "./config.js";

/** Downloads land here first (one private sub-directory per run) and the finished file is moved to `_quarantine/<uuid>`. */
export const QUARANTINE_DIR = "_quarantine";
const FETCH_TMP_PREFIX = ".fetch-";
const MIN_STEP_BUDGET_MS = 4_000;

export type SocialFetchProcessorDeps = {
  config: { mediaRoot: string; ffmpegPath: string; ffprobePath: string };
  fetch: SocialFetchConfig;
  runner: ProcessRunner;
  now?: () => number;
  log?: (message: string) => void;
};

class FetchStepError extends Error {
  constructor(readonly code: MediaFetchErrorCode, message: string) {
    super(message);
  }
}

type StepOutcome<T> = { ok: true; value: T } | { ok: false; code: MediaFetchErrorCode; message: string };

const emptyInfo = (): SocialMediaInfo => ({
  externalId: null,
  title: null,
  description: null,
  uploader: null,
  channel: null,
  webpageUrl: null,
  durationSeconds: null,
  width: null,
  height: null,
  thumbnailUrl: null,
  viewCount: null,
  likeCount: null,
  uploadDate: null,
  tags: [],
  language: null,
});

const RETRYABLE: ReadonlySet<MediaJobErrorCode> = new Set(["FETCH_FORBIDDEN", "FETCH_BOT_CHECK", "FETCH_RATE_LIMITED", "FETCH_NETWORK", "FETCH_TIMEOUT"]);

/**
 * VE2E-144: executes `media.fetch` / `media.search` with yt-dlp (video) and gallery-dl (images). Never throws: every failure is an
 * `ok: false` result with a normalised `FETCH_*` code and the list of runs, so the API can apply its own recovery (rotate cookies,
 * proxy, Apify, next candidate). Inside one job the worker only does what needs no other secret: one fresh re-extraction, then one
 * browser-impersonated run (cli.ts `nextFetchStep`). Concurrent deliveries of one jobKey share the same run.
 */
export class SocialFetchProcessor {
  private readonly inflight = new Map<string, Promise<MediaFetchResult | MediaSearchResult>>();
  private readonly versions = new Map<SocialFetchTool, Promise<string>>();
  /** Set once a run reports that curl_cffi is missing; later jobs skip the impersonation step. */
  private impersonationWorks = true;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: SocialFetchProcessorDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  handleFetch(raw: unknown): Promise<MediaFetchResult> {
    const validation = validateMediaFetchJob(raw);
    if (!validation.ok) return Promise.resolve(this.fetchFailure(this.keyOf(raw), "INVALID_JOB", validation.errors.join("; "), []));
    return this.dedupe(validation.value.jobKey, () => this.runFetch(validation.value)) as Promise<MediaFetchResult>;
  }

  handleSearch(raw: unknown): Promise<MediaSearchResult> {
    const validation = validateMediaSearchJob(raw);
    if (!validation.ok) return Promise.resolve(this.searchFailure(this.keyOf(raw), "INVALID_JOB", validation.errors.join("; "), []));
    return this.dedupe(validation.value.jobKey, () => this.runSearch(validation.value)) as Promise<MediaSearchResult>;
  }

  private keyOf(raw: unknown): string {
    return typeof (raw as { jobKey?: unknown } | null)?.jobKey === "string" ? (raw as { jobKey: string }).jobKey : "invalid";
  }

  private dedupe<T extends MediaFetchResult | MediaSearchResult>(jobKey: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(jobKey);
    if (existing) return existing as Promise<T>;
    const running = run().finally(() => this.inflight.delete(jobKey));
    this.inflight.set(jobKey, running);
    return running;
  }

  private binary(tool: SocialFetchTool): string {
    return tool === "yt-dlp" ? this.deps.fetch.ytDlpPath : this.deps.fetch.galleryDlPath;
  }

  /** `--version` once per tool (lazily: a worker without the CLIs still serves every other job type). */
  private version(tool: SocialFetchTool): Promise<string> {
    let cached = this.versions.get(tool);
    if (!cached) {
      cached = this.deps.runner(this.binary(tool), ["--version"], { timeoutMs: 15_000, maxStdoutBytes: 4096 }).then((r) => {
        if (r.exitCode !== 0) throw new Error(`${tool} --version exited ${r.exitCode}`);
        return parseToolVersion(r.stdout);
      });
      cached.catch(() => this.versions.delete(tool));
      this.versions.set(tool, cached);
    }
    return cached;
  }

  private async cookiesPath(relativePath: string | null): Promise<string | null> {
    if (!relativePath) return null;
    try {
      return await resolveMediaSource(this.deps.config.mediaRoot, relativePath);
    } catch {
      throw new FetchStepError("FETCH_COOKIES_INVALID", "cookies file handed over by the API is missing");
    }
  }

  private access(job: { useProxy: boolean }, cookiesPath: string | null, step: MediaFetchAttemptStep): CliAccess {
    return { cookiesPath, proxyUrl: job.useProxy ? this.deps.fetch.proxyUrl : null, impersonate: step === "impersonate" };
  }

  /** Runs `attemptOnce` with the in-worker recovery ladder inside the job's time budget. */
  private async withRecovery<T>(
    job: { timeoutMs: number; impersonate: "auto" | "always" | "never" },
    attempts: MediaFetchAttempt[],
    attemptOnce: (step: MediaFetchAttemptStep, budgetMs: number) => Promise<StepOutcome<T>>,
  ): Promise<StepOutcome<T>> {
    const deadline = this.now() + job.timeoutMs;
    let step: MediaFetchAttemptStep | null = firstFetchStep(job.impersonate);
    let last: StepOutcome<T> = { ok: false, code: "FETCH_FAILED", message: "no run" };
    while (step) {
      const budget = deadline - this.now();
      if (budget < MIN_STEP_BUDGET_MS) {
        if (attempts.length === 0) last = { ok: false, code: "FETCH_TIMEOUT", message: "no time budget left" };
        break;
      }
      const startedAt = this.now();
      last = await attemptOnce(step, budget);
      attempts.push({ step, code: last.ok ? null : last.code, elapsedMs: this.now() - startedAt });
      if (last.ok) return last;
      if (!last.ok && impersonationUnavailable(last.message)) this.impersonationWorks = false;
      step = nextFetchStep(attempts, job.impersonate, this.impersonationWorks);
    }
    return last;
  }

  /** One CLI run; a crash/timeout/missing binary becomes a step failure (never an exception). */
  private async run(tool: SocialFetchTool, args: string[], timeoutMs: number, maxStdoutBytes = 2 * 1024 * 1024): Promise<StepOutcome<{ stdout: string; stderr: string }>> {
    try {
      const result = await this.deps.runner(this.binary(tool), args, { timeoutMs, maxStdoutBytes });
      if (result.exitCode === 0) return { ok: true, value: { stdout: result.stdout, stderr: result.stderrTail } };
      return { ok: false, code: classifyFetchFailure(tool, result.exitCode, result.stderrTail), message: redactCliText(result.stderrTail || `${tool} exited ${result.exitCode}`) };
    } catch (error) {
      if (error instanceof ProcessTimeoutError) return { ok: false, code: "FETCH_TIMEOUT", message: `${tool} exceeded ${timeoutMs}ms` };
      if (error instanceof BinaryNotFoundError) return { ok: false, code: "FETCH_TOOL_MISSING", message: `${tool} is not installed (set ${tool === "yt-dlp" ? "YTDLP_PATH" : "GALLERY_DL_PATH"})` };
      return { ok: false, code: "FETCH_FAILED", message: redactCliText(error instanceof Error ? error.message : String(error)) };
    }
  }

  // --- media.fetch ------------------------------------------------------------------------------

  private async runFetch(job: MediaFetchJob): Promise<MediaFetchResult> {
    const startedAt = this.now();
    const attempts: MediaFetchAttempt[] = [];
    let version: string;
    try {
      version = await this.version(job.tool);
    } catch (error) {
      const missing = error instanceof BinaryNotFoundError;
      return this.fetchFailure(job.jobKey, missing ? "FETCH_TOOL_MISSING" : "FETCH_FAILED", missing ? `${job.tool} is not installed on the media worker` : redactCliText(String(error)), attempts);
    }
    let cookies: string | null;
    try {
      cookies = await this.cookiesPath(job.cookiesRelativePath);
    } catch (error) {
      return this.fetchFailure(job.jobKey, (error as FetchStepError).code, (error as FetchStepError).message, attempts);
    }
    const quarantine = join(this.deps.config.mediaRoot, QUARANTINE_DIR);
    await mkdir(quarantine, { recursive: true });

    const outcome = await this.withRecovery(job, attempts, async (step, budgetMs) => {
      const tmpDir = join(quarantine, `${FETCH_TMP_PREFIX}${randomUUID()}`);
      await mkdir(tmpDir, { recursive: true });
      try {
        return await this.downloadOnce(job, step, budgetMs, cookies, tmpDir, quarantine);
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
    if (!outcome.ok) {
      this.log(`media.fetch ${job.jobKey} ${job.tool}/${job.platform} failed ${outcome.code} after ${attempts.map((a) => `${a.step}:${a.code ?? "ok"}`).join(",")}`);
      return this.fetchFailure(job.jobKey, outcome.code, outcome.message, attempts);
    }
    const { token, bytes, sha256, info, probe } = outcome.value;
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: MEDIA_FETCH_RESULT_TYPE,
      ok: true,
      jobKey: job.jobKey,
      quarantineToken: token,
      bytes,
      sha256,
      probe,
      info,
      attempts,
      tool: { name: job.tool, version, profileVersion: MEDIA_FETCH_PROFILE_VERSION },
      elapsedMs: this.now() - startedAt,
      completedAt: new Date(this.now()).toISOString(),
    };
  }

  private async downloadOnce(
    job: MediaFetchJob,
    step: MediaFetchAttemptStep,
    budgetMs: number,
    cookies: string | null,
    tmpDir: string,
    quarantine: string,
  ): Promise<StepOutcome<{ token: string; bytes: number; sha256: string; info: SocialMediaInfo; probe: MediaFetchSuccess["probe"] }>> {
    const access = this.access(job, cookies, step);
    const args =
      job.tool === "yt-dlp"
        ? buildYtDlpFetchArgs({
            url: job.url,
            outputTemplate: join(tmpDir, "media.%(ext)s"),
            maxBytes: job.maxBytes,
            ffmpegPath: this.deps.config.ffmpegPath,
            access,
            section: job.sectionStartMs !== null && job.sectionDurationMs !== null ? { startMs: job.sectionStartMs, durationMs: job.sectionDurationMs } : null,
          })
        : buildGalleryDlFetchArgs({ url: job.url, directory: tmpDir, maxBytes: job.maxBytes, access });
    const ran = await this.run(job.tool, args, budgetMs);
    if (!ran.ok) return ran;
    const files = (await readdir(tmpDir).catch(() => [] as string[])).filter((f) => f.startsWith("media.") && !f.endsWith(".json") && !f.endsWith(".part") && !f.endsWith(".ytdl"));
    if (files.length === 0) {
      // yt-dlp skips (exit 0, no file) when --max-filesize is exceeded; gallery-dl likewise for --filesize-max.
      const code = classifyFetchFailure(job.tool, 0, ran.value.stderr);
      return { ok: false, code: code === "FETCH_FAILED" ? "FETCH_FAILED" : code, message: redactCliText(ran.value.stderr || "the tool finished without producing a file") };
    }
    const file = join(tmpDir, files[0]!);
    const size = (await stat(file)).size;
    if (size === 0) return { ok: false, code: "FETCH_FAILED", message: "downloaded file is empty" };
    if (size > job.maxBytes) return { ok: false, code: "FETCH_TOO_LARGE", message: `downloaded file is ${size} bytes (> ${job.maxBytes})` };

    let info = emptyInfo();
    if (job.tool === "yt-dlp") {
      const json = lastJsonLine(ran.value.stdout);
      if (json) info = ytdlpInfo(json);
    } else {
      const meta = await readFile(`${file}.json`, "utf8").then((t) => parseJsonKeepingBigIds(t) as Record<string, unknown>).catch(() => null);
      if (meta) info = galleryInfo(job.platform, meta);
    }

    let probe: MediaFetchSuccess["probe"] = null;
    if (job.mediaType === "video") {
      try {
        const probed = await this.deps.runner(this.deps.config.ffprobePath, buildProbeArgs(file), { timeoutMs: 30_000 });
        const parsed = probed.exitCode === 0 ? parseProbeJson(probed.stdout) : null;
        if (parsed && !parsed.ok && parsed.reason === "no_video_stream") return { ok: false, code: "FETCH_FAILED", message: "downloaded file has no video stream" };
        if (parsed?.ok) probe = { durationMs: parsed.probe.durationMs, width: parsed.probe.video.displayWidth, height: parsed.probe.video.displayHeight, videoCodec: parsed.probe.video.codec };
      } catch {
        // The probe is evidence, not a gate: the API still sniffs the bytes and the later clip.prepare probes again.
      }
    }
    const sha256 = await sha256File(file);
    const token = randomUUID();
    await rename(file, join(quarantine, token));
    return { ok: true, value: { token, bytes: size, sha256, info, probe } };
  }

  // --- media.search -----------------------------------------------------------------------------

  private async runSearch(job: MediaSearchJob): Promise<MediaSearchResult> {
    const startedAt = this.now();
    const attempts: MediaFetchAttempt[] = [];
    let version: string;
    try {
      version = await this.version(job.tool);
    } catch (error) {
      const missing = error instanceof BinaryNotFoundError;
      return this.searchFailure(job.jobKey, missing ? "FETCH_TOOL_MISSING" : "FETCH_FAILED", missing ? `${job.tool} is not installed on the media worker` : redactCliText(String(error)), attempts);
    }
    let cookies: string | null;
    try {
      cookies = await this.cookiesPath(job.cookiesRelativePath);
    } catch (error) {
      return this.searchFailure(job.jobKey, (error as FetchStepError).code, (error as FetchStepError).message, attempts);
    }
    const url = job.tool === "gallery-dl" ? gallerySearchUrl(job.platform, job.query) : null;
    if (job.tool === "gallery-dl" && !url) return this.searchFailure(job.jobKey, "INVALID_JOB", `gallery-dl cannot search ${job.platform}`, attempts);

    const outcome = await this.withRecovery<SocialSearchItem[]>(job, attempts, async (step, budgetMs) => {
      const access = this.access(job, cookies, step);
      const args = job.tool === "yt-dlp" ? buildYtDlpSearchArgs({ query: job.query, limit: job.limit, access }) : buildGalleryDlSearchArgs({ url: url!, limit: job.limit, access });
      const ran = await this.run(job.tool, args, budgetMs, 16 * 1024 * 1024);
      if (!ran.ok) return ran;
      return { ok: true, value: job.tool === "yt-dlp" ? parseYtDlpSearch(ran.value.stdout, job.limit) : parseGallerySearch(job.platform, ran.value.stdout, job.mediaType, job.limit) };
    });
    if (!outcome.ok) return this.searchFailure(job.jobKey, outcome.code, outcome.message, attempts);
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: MEDIA_SEARCH_RESULT_TYPE,
      ok: true,
      jobKey: job.jobKey,
      items: outcome.value,
      attempts,
      tool: { name: job.tool, version, profileVersion: MEDIA_FETCH_PROFILE_VERSION },
      elapsedMs: this.now() - startedAt,
      completedAt: new Date(this.now()).toISOString(),
    };
  }

  // --- results ----------------------------------------------------------------------------------

  private fetchFailure(jobKey: string, code: MediaJobErrorCode, message: string, attempts: MediaFetchAttempt[]): MediaFetchFailure {
    return {
      schemaVersion: MEDIA_JOB_SCHEMA_VERSION,
      type: MEDIA_FETCH_RESULT_TYPE,
      ok: false,
      jobKey,
      error: { code, message, retryable: RETRYABLE.has(code), attempts: attempts.length },
      attempts,
      completedAt: new Date(this.now()).toISOString(),
    };
  }

  private searchFailure(jobKey: string, code: MediaJobErrorCode, message: string, attempts: MediaFetchAttempt[]): MediaSearchFailure {
    return { ...this.fetchFailure(jobKey, code, message, attempts), type: MEDIA_SEARCH_RESULT_TYPE };
  }
}

/** Removes `_quarantine/.fetch-*` run directories older than `maxAgeMs` (a worker killed mid-download leaves them behind). */
export async function sweepStaleFetchDirs(mediaRoot: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const dir = join(mediaRoot, QUARANTINE_DIR);
  const entries = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(FETCH_TMP_PREFIX)) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (info && now - info.mtimeMs > maxAgeMs) {
      await rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}
