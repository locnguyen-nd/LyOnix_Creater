/**
 * VE2E-96: TikTok URL -> clean transcript for the create-video page.
 *  1. the link must be a TikTok VIDEO (short links vm./vt./www.tiktok.com/t/ are resolved, staying on TikTok hosts);
 *  2. the configured VideoTranscriptSource (Apify) gives the video's subtitle tracks and media file;
 *  3. a subtitle is downloaded (SSRF-safe, allow-listed hosts, 2 MB) and cleaned - method `subtitle`;
 *  4. else the media file (SSRF-safe, 50 MB) goes to the configured SpeechToTextProvider - method `speech_to_text`;
 *  5. else a clear error: nothing is invented, nothing in the form is touched.
 * Retryable provider errors are tried once more. A result is cached 30 minutes per video (no second paid run for the same link).
 * Logs carry the video id, provider ids, timings and error codes - never a key, token or signed URL.
 */
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { TIKTOK_VIDEO_HOSTS, cleanTranscript, countWords, detectTextLanguage, parseSubtitleDocument, parseTikTokUrl } from "@lyonix/domain";
import { TranscriptError, withTranscriptRetry, type TikTokVideoInfo, type TranscriptDownload } from "@lyonix/providers";
import type { UrlIntakeErrorCode, UrlIntakeSource } from "@lyonix/contracts";
import { fetchBinarySafely, type SafeBinaryFetchResult } from "./safe-binary-fetch.js";
import { transcriptProvidersFromEnv, type TranscriptProviders } from "./transcript-config.js";

export const TIKTOK_INTAKE_LIMITS = {
  sourceRunTimeoutSecs: 120,
  sttTimeoutMs: 120_000,
  subtitleMaxBytes: 2_000_000,
  mediaMaxBytes: 50 * 1024 * 1024,
  shortLinkTimeoutMs: 10_000,
  cacheMs: 30 * 60_000,
  maxTextChars: 20_000,
} as const;

export type TikTokIntakeOutcome = { ok: true; source: UrlIntakeSource } | { ok: false; code: UrlIntakeErrorCode; message: string };

type ShortLinkFetch = (url: string, init: { method: "GET"; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export const TIKTOK_INTAKE_OPTIONS = "TIKTOK_INTAKE_OPTIONS";
export type TikTokIntakeOptions = {
  providers?: () => TranscriptProviders;
  download?: typeof fetchBinarySafely;
  shortLinkFetch?: ShortLinkFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Follows a TikTok short link (manual redirects, TikTok hosts only, <= 5 hops) to the video URL; null when it does not lead to one. */
export async function resolveTikTokShortLink(url: string, fetchImpl: ShortLinkFetch, timeoutMs: number = TIKTOK_INTAKE_LIMITS.shortLinkTimeoutMs): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    let response: Awaited<ReturnType<ShortLinkFetch>>;
    try {
      response = await fetchImpl(current, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "Mozilla/5.0 (compatible; LyOnix-Intake/1.0)" } });
    } catch {
      return null;
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return null;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (next.protocol !== "https:" || !(TIKTOK_VIDEO_HOSTS as readonly string[]).includes(next.hostname.toLowerCase())) return null;
    const parsed = parseTikTokUrl(next.toString());
    if (parsed?.kind === "video") return parsed.url;
    current = next.toString();
  }
  return null;
}

const ERROR_CODE: Record<TranscriptError["code"], UrlIntakeErrorCode> = {
  not_configured: "transcript_provider_not_configured",
  not_found: "tiktok_not_found",
  timeout: "transcript_timeout",
  rate_limited: "transcript_rate_limited",
  auth_invalid: "transcript_auth_invalid",
  unavailable: "transcript_failed",
  unsupported_media: "transcript_failed",
};

const ISO3: Record<string, string> = { jpn: "ja", eng: "en", kor: "ko", vie: "vi", zho: "zh", cmn: "zh" };
const twoLetter = (code: string | null | undefined): string | null => {
  const head = (code ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  return ISO3[head] ?? (/^[a-z]{2}$/.test(head) ? head : null);
};

@Injectable()
export class TikTokIntakeService {
  private readonly logger = new Logger("TikTokIntake");
  private readonly cache = new Map<string, { at: number; source: UrlIntakeSource }>();
  private readonly providers: () => TranscriptProviders;
  private readonly download: typeof fetchBinarySafely;
  private readonly shortLinkFetch: ShortLinkFetch;
  private readonly now: () => number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(@Optional() @Inject(TIKTOK_INTAKE_OPTIONS) options?: TikTokIntakeOptions) {
    this.providers = options?.providers ?? (() => transcriptProvidersFromEnv());
    this.download = options?.download ?? fetchBinarySafely;
    this.shortLinkFetch = options?.shortLinkFetch ?? ((url, init) => fetch(url, init));
    this.now = options?.now ?? Date.now;
    this.sleep = options?.sleep;
  }

  async read(rawUrl: string, options: { languageHint?: string | null } = {}): Promise<TikTokIntakeOutcome> {
    const parsed = parseTikTokUrl(rawUrl);
    if (!parsed) return { ok: false, code: "invalid_tiktok_url", message: "Không phải link video TikTok (cần dạng tiktok.com/@user/video/..., vm.tiktok.com/..., vt.tiktok.com/...)" };
    const { video: source, stt } = this.providers();
    if (!source) return { ok: false, code: "transcript_provider_not_configured", message: "Transcript provider chưa được cấu hình (TIKTOK_SOURCE_PROVIDER)" };

    const url = parsed.kind === "video" ? parsed.url : await resolveTikTokShortLink(parsed.url, this.shortLinkFetch);
    if (!url) return { ok: false, code: "tiktok_resolve_failed", message: "Không mở được link rút gọn TikTok thành link video" };
    const videoId = /\/video\/(\d+)|\/v\/(\d+)\.html/.exec(url);
    const cacheKey = videoId?.[1] ?? videoId?.[2] ?? url;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < TIKTOK_INTAKE_LIMITS.cacheMs) return { ok: true, source: cached.source };

    const started = this.now();
    let info: TikTokVideoInfo;
    try {
      info = await withTranscriptRetry(() => source.resolveTikTok(url, { language: options.languageHint ?? null, timeoutSecs: TIKTOK_INTAKE_LIMITS.sourceRunTimeoutSecs }), this.retryOptions());
    } catch (error) {
      return this.fail(error, cacheKey, source.id);
    }

    // 1) subtitles: the video's own language first
    const tracks = [...info.subtitles].sort((a, b) => Number(twoLetter(b.language) === info.language) - Number(twoLetter(a.language) === info.language)).slice(0, 3);
    for (const track of tracks) {
      const document = track.text ?? (track.download ? await this.fetchText(track.download) : null);
      if (!document) continue;
      const cues = parseSubtitleDocument(document);
      const cleaned = cleanTranscript(cues);
      if (!cleaned) continue;
      this.logger.log(`video ${info.videoId}: subtitle (${twoLetter(track.language) ?? "?"}) via ${source.id} in ${this.now() - started} ms`);
      return this.done(cacheKey, info, { raw: cues.join("\n"), cleaned, method: "subtitle", providerUsed: source.id, language: twoLetter(track.language) ?? info.language });
    }

    // 2) speech-to-text on the video file
    if (!stt) return { ok: false, code: "stt_provider_not_configured", message: "Video không có phụ đề lấy được và Speech-to-Text provider chưa được cấu hình (STT_PROVIDER)" };
    if (!info.media) return { ok: false, code: "media_unavailable", message: "Video không có phụ đề và không lấy được file video để chuyển giọng nói thành chữ" };
    const media = await this.download(info.media.url, this.downloadOptions(info.media, TIKTOK_INTAKE_LIMITS.mediaMaxBytes, ["video/", "audio/", "application/octet-stream", "binary/octet-stream"]));
    if (!media.ok) return this.downloadFailure(media, info.videoId);
    if (media.buffer.byteLength === 0) return { ok: false, code: "media_unavailable", message: "File video tải về rỗng" };
    let spoken: { text: string; language: string | null };
    try {
      spoken = await withTranscriptRetry(
        () => stt.transcribeAudio({ audio: new Uint8Array(media.buffer), mimeType: media.mimeType || "video/mp4", fileName: `tiktok-${info.videoId}.mp4`, languageHint: info.language }, { timeoutMs: TIKTOK_INTAKE_LIMITS.sttTimeoutMs }),
        this.retryOptions(),
      );
    } catch (error) {
      return this.fail(error, info.videoId, stt.id);
    }
    const cleaned = cleanTranscript(spoken.text);
    if (!cleaned) return { ok: false, code: "transcript_empty", message: "Không nghe được lời nói nào trong video (transcript rỗng)" };
    this.logger.log(`video ${info.videoId}: speech_to_text via ${source.id}+${stt.id} in ${this.now() - started} ms`);
    return this.done(cacheKey, info, { raw: spoken.text, cleaned, method: "speech_to_text", providerUsed: `${source.id}+${stt.id}`, language: twoLetter(spoken.language) ?? info.language });
  }

  private retryOptions() {
    return this.sleep ? { retries: 1, sleep: this.sleep } : { retries: 1 };
  }

  private downloadOptions(file: TranscriptDownload, maxBytes: number, allowedMimePrefixes: readonly string[]) {
    return { maxBytes, allowedHostSuffixes: file.hostSuffixes, allowedMimePrefixes, ...(file.scopedHeaders ? { hostScopedHeaders: file.scopedHeaders } : {}) };
  }

  private async fetchText(file: TranscriptDownload): Promise<string | null> {
    const result = await this.download(file.url, this.downloadOptions(file, TIKTOK_INTAKE_LIMITS.subtitleMaxBytes, ["text/", "application/x-subrip", "application/octet-stream", "binary/octet-stream"]));
    return result.ok ? result.buffer.toString("utf8") : null;
  }

  private downloadFailure(result: Extract<SafeBinaryFetchResult, { ok: false }>, videoId: string): TikTokIntakeOutcome {
    this.logger.warn(`video ${videoId}: media download failed (${result.reason})`);
    if (result.reason === "too_large") return { ok: false, code: "too_large", message: "File video quá lớn để chuyển giọng nói thành chữ" };
    if (result.reason === "ssrf_blocked" || result.reason === "domain_not_allowed") return { ok: false, code: "ssrf_blocked", message: "Link file video bị chặn bởi kiểm tra an toàn" };
    return { ok: false, code: "media_unavailable", message: "Không tải được file video để chuyển giọng nói thành chữ" };
  }

  private fail(error: unknown, videoId: string, providerId: string): TikTokIntakeOutcome {
    const code = error instanceof TranscriptError ? ERROR_CODE[error.code] : "transcript_failed";
    this.logger.warn(`video ${videoId}: ${providerId} failed (${error instanceof TranscriptError ? error.code : "error"})`);
    const message: Record<string, string> = {
      tiktok_not_found: "Không tìm thấy video TikTok (đã xoá, riêng tư hoặc không phải video)",
      transcript_timeout: "Provider transcript không trả lời kịp (timeout)",
      transcript_rate_limited: "Provider transcript đang giới hạn tốc độ / hết quota",
      transcript_auth_invalid: "Khoá API của provider transcript bị từ chối",
    };
    return { ok: false, code, message: message[code] ?? "Không lấy được transcript từ provider" };
  }

  private done(cacheKey: string, info: TikTokVideoInfo, text: { raw: string; cleaned: string; method: "subtitle" | "speech_to_text"; providerUsed: string; language: string | null }): TikTokIntakeOutcome {
    const cleaned = [...text.cleaned];
    const caption = info.caption?.replace(/#[^\s#]+/g, " ").replace(/\s+/g, " ").trim() ?? "";
    const source: UrlIntakeSource = {
      sourceType: "tiktok",
      sourceUrl: info.url,
      title: caption ? [...caption].slice(0, 120).join("") : null,
      sourceName: info.author ? `TikTok · @${info.author}` : "TikTok",
      publishedAt: null,
      rawText: [...text.raw].slice(0, TIKTOK_INTAKE_LIMITS.maxTextChars).join(""),
      cleanedText: cleaned.slice(0, TIKTOK_INTAKE_LIMITS.maxTextChars).join(""),
      language: text.language ?? detectTextLanguage(text.cleaned),
      characterCount: Math.min(cleaned.length, TIKTOK_INTAKE_LIMITS.maxTextChars),
      wordCount: countWords(text.cleaned),
      method: text.method,
      providerUsed: text.providerUsed,
      truncated: cleaned.length > TIKTOK_INTAKE_LIMITS.maxTextChars,
      newsItem: null,
    };
    this.cache.set(cacheKey, { at: this.now(), source });
    return { ok: true, source };
  }
}
