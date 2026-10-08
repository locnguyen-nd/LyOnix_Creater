/**
 * VE2E-96: TikTok URL -> clean transcript for the create-video page.
 *  1. the link must be a TikTok VIDEO (short links vm./vt./www.tiktok.com/t/ are resolved, staying on TikTok hosts);
 *  2. the configured VideoTranscriptSource (Apify) gives the video's subtitle tracks and media file;
 *  3. a subtitle is downloaded (SSRF-safe, allow-listed hosts, 2 MB) and cleaned - method `subtitle`;
 *  4. else every media link the provider gave (stored copy first, then TikTok CDN) is tried (SSRF-safe, 50 MB) and the first file
 *     that downloads goes to the SpeechToTextProvider (Provider Settings ElevenLabs first, env fallback) - method `speech_to_text`;
 *  5. else ONE precise error: no subtitle and no media / media not downloadable / speech-to-text not configured or failed.
 *     Nothing is invented, nothing in the form is touched.
 * Retryable provider errors are tried once more. A result is cached 30 minutes per video (no second paid run for the same link).
 * Logs carry the video id, provider ids, timings and error codes - never a key, token or signed URL.
 */
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { TIKTOK_VIDEO_HOSTS, cleanTranscript, countWords, detectTextLanguage, parseSubtitleDocument, parseTikTokUrl } from "@lyonix/domain";
import { TranscriptError, withTranscriptRetry, type TikTokVideoInfo, type TranscriptDownload, type TranscriptErrorCode } from "@lyonix/providers";
import type { UrlIntakeErrorCode, UrlIntakeSource, UrlIntakeStage } from "@lyonix/contracts";
import { fetchBinarySafely, type SafeBinaryFetchResult } from "./safe-binary-fetch.js";
import { TranscriptProviderResolver, type TranscriptContext, type TranscriptResolver } from "./transcript-config.js";

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

/** TikTok provider (Apify) failures -> intake codes. */
const SOURCE_ERROR: Record<TranscriptErrorCode, UrlIntakeErrorCode> = {
  not_configured: "transcript_provider_not_configured",
  not_found: "tiktok_not_found",
  timeout: "transcript_timeout",
  rate_limited: "transcript_rate_limited",
  quota_exhausted: "provider_quota_exhausted",
  auth_invalid: "transcript_auth_invalid",
  unavailable: "tiktok_provider_failed",
  unsupported_media: "tiktok_provider_failed",
  empty_result: "tiktok_provider_empty",
};

/** Speech-to-text failures -> intake codes. */
const STT_ERROR: Record<TranscriptErrorCode, UrlIntakeErrorCode> = {
  not_configured: "stt_provider_not_configured",
  not_found: "stt_failed",
  timeout: "stt_timeout",
  rate_limited: "stt_rate_limited",
  quota_exhausted: "stt_quota_exhausted",
  auth_invalid: "stt_auth_invalid",
  unavailable: "stt_failed",
  unsupported_media: "stt_unsupported_media",
  empty_result: "stt_failed",
};

/** One precise sentence per failure (the UI shows its own translation of the code; this is the API / log wording). */
export const TIKTOK_INTAKE_MESSAGES: Partial<Record<UrlIntakeErrorCode, string>> = {
  transcript_provider_not_configured: "Chưa cấu hình Apify. Vào Cài đặt > Provider để thêm tài khoản.",
  tiktok_not_found: "Không tìm thấy video TikTok (đã xoá, riêng tư hoặc không phải video).",
  tiktok_provider_empty: "TikTok provider không trả về dữ liệu nào cho video này.",
  tiktok_provider_failed: "TikTok provider (Apify) báo lỗi khi đọc video. Thử lại sau.",
  provider_quota_exhausted: "Tài khoản Apify đã hết hạn mức sử dụng (credit). Nâng gói hoặc chờ chu kỳ mới rồi thử lại.",
  transcript_timeout: "TikTok provider (Apify) không trả lời kịp. Thử lại sau.",
  transcript_rate_limited: "TikTok provider (Apify) đang giới hạn tốc độ. Thử lại sau ít phút.",
  transcript_auth_invalid: "Khoá API Apify bị từ chối. Verify lại tài khoản trong Cài đặt > Provider.",
  no_subtitle_no_media: "TikTok provider không trả về subtitle hoặc media.",
  stt_provider_not_configured: "Chưa cấu hình Speech-to-Text provider. Video không có phụ đề: thêm tài khoản ElevenLabs trong Cài đặt > Provider.",
  media_unavailable: "Không lấy được media từ TikTok để nhận dạng giọng nói.",
  too_large: "File video quá lớn (trên 50 MB) để nhận dạng giọng nói.",
  ssrf_blocked: "Link media bị chặn bởi kiểm tra an toàn.",
  stt_failed: "Speech-to-Text thất bại.",
  stt_timeout: "Speech-to-Text thất bại: provider không trả lời kịp (timeout).",
  stt_auth_invalid: "Speech-to-Text thất bại: khoá ElevenLabs bị từ chối hoặc không có quyền Speech-to-Text.",
  stt_rate_limited: "Speech-to-Text thất bại: provider đang giới hạn tốc độ. Thử lại sau.",
  stt_quota_exhausted: "Speech-to-Text thất bại: tài khoản ElevenLabs đã hết credit.",
  stt_unsupported_media: "Speech-to-Text thất bại: không đọc được âm thanh trong file video.",
  transcript_empty: "Không nghe được lời nói nào trong video (transcript rỗng).",
};

const failure = (code: UrlIntakeErrorCode): TikTokIntakeOutcome => ({ ok: false, code, message: TIKTOK_INTAKE_MESSAGES[code] ?? code });

const ISO3: Record<string, string> = { jpn: "ja", eng: "en", kor: "ko", vie: "vi", zho: "zh", cmn: "zh" };
const twoLetter = (code: string | null | undefined): string | null => {
  const head = (code ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  return ISO3[head] ?? (/^[a-z]{2}$/.test(head) ? head : null);
};

/** Host only (never the path / query: a signed link carries credentials). */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "?";
  }
};

@Injectable()
export class TikTokIntakeService {
  private readonly logger = new Logger("TikTokIntake");
  private readonly cache = new Map<string, { at: number; source: UrlIntakeSource }>();
  private readonly download: typeof fetchBinarySafely;
  private readonly shortLinkFetch: ShortLinkFetch;
  private readonly now: () => number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(@Inject(TranscriptProviderResolver) private readonly resolver: TranscriptResolver, @Optional() @Inject(TIKTOK_INTAKE_OPTIONS) options?: TikTokIntakeOptions) {
    this.download = options?.download ?? fetchBinarySafely;
    this.shortLinkFetch = options?.shortLinkFetch ?? ((url, init) => fetch(url, init));
    this.now = options?.now ?? Date.now;
    this.sleep = options?.sleep;
  }

  /**
   * `context`: whose Provider Settings accounts are used; `onStage`: progress as it really happens -
   * reading > subtitles > (no subtitle: no_subtitles > downloading > speech) > cleaning.
   */
  async read(rawUrl: string, options: { context: TranscriptContext; languageHint?: string | null; onStage?: (stage: UrlIntakeStage) => void }): Promise<TikTokIntakeOutcome> {
    const stage = (value: UrlIntakeStage) => options.onStage?.(value);
    const parsed = parseTikTokUrl(rawUrl);
    if (!parsed) return { ok: false, code: "invalid_tiktok_url", message: "Không phải link video TikTok (cần dạng tiktok.com/@user/video/..., vm.tiktok.com/..., vt.tiktok.com/...)" };
    stage("reading");

    const url = parsed.kind === "video" ? parsed.url : await resolveTikTokShortLink(parsed.url, this.shortLinkFetch);
    if (!url) return { ok: false, code: "tiktok_resolve_failed", message: "Không mở được link rút gọn TikTok thành link video" };
    const videoId = /\/video\/(\d+)|\/v\/(\d+)\.html/.exec(url);
    const cacheKey = videoId?.[1] ?? videoId?.[2] ?? url;
    const cached = this.cache.get(cacheKey);
    if (cached && this.now() - cached.at < TIKTOK_INTAKE_LIMITS.cacheMs) return { ok: true, source: cached.source };
    const source = await this.resolver.video(options.context);
    if (!source) return failure("transcript_provider_not_configured");

    // 1) the TikTok provider: subtitle tracks + media links
    const started = this.now();
    let info: TikTokVideoInfo;
    try {
      info = await withTranscriptRetry(() => source.resolveTikTok(url, { language: options.languageHint ?? null, timeoutSecs: TIKTOK_INTAKE_LIMITS.sourceRunTimeoutSecs }), this.retryOptions());
    } catch (error) {
      return this.fail("source", error, cacheKey, source.id);
    }
    this.logSource(info, source.id, this.now() - started);

    // 2) subtitles: the video's own language first; a track that cannot be downloaded or is empty is skipped
    stage("subtitles");
    const tracks = [...info.subtitles].sort((a, b) => Number(twoLetter(b.language) === info.language) - Number(twoLetter(a.language) === info.language)).slice(0, 3);
    for (const track of tracks) {
      const document = track.text ?? (track.download ? await this.fetchText(track.download) : null);
      if (!document) continue;
      const cues = parseSubtitleDocument(document);
      const cleaned = cleanTranscript(cues);
      if (!cleaned) continue;
      stage("cleaning");
      this.logger.log(`video ${info.videoId}: subtitle (${twoLetter(track.language) ?? "?"}) via ${source.id} in ${this.now() - started} ms`);
      return this.done(cacheKey, info, { raw: cues.join("\n"), cleaned, method: "subtitle", providerUsed: source.id, language: twoLetter(track.language) ?? info.language });
    }

    // 3) no usable subtitle: speech-to-text on the video file
    stage("no_subtitles");
    const candidates = info.mediaCandidates?.length ? info.mediaCandidates : info.media ? [info.media] : [];
    if (candidates.length === 0) {
      this.logger.warn(`video ${info.videoId}: no usable subtitle and no media link from ${source.id}`);
      return failure("no_subtitle_no_media");
    }
    // only now is a speech-to-text account looked up (Provider Settings first, env fallback): a video with subtitles never reaches it
    const stt = await this.resolver.stt(options.context);
    if (!stt) return failure("stt_provider_not_configured");

    stage("downloading");
    let media: Extract<SafeBinaryFetchResult, { ok: true }> | null = null;
    const reasons: string[] = [];
    for (const [index, file] of candidates.entries()) {
      const result = await this.download(file.url, this.downloadOptions(file, TIKTOK_INTAKE_LIMITS.mediaMaxBytes, ["video/", "audio/", "application/octet-stream", "binary/octet-stream"]));
      if (result.ok && result.buffer.byteLength > 0) {
        media = result;
        break;
      }
      const reason = result.ok ? "empty" : result.reason;
      reasons.push(reason);
      this.logger.warn(`video ${info.videoId}: media ${index + 1}/${candidates.length} (${hostOf(file.url)}) not usable (${reason})`);
    }
    if (!media) return failure(reasons.includes("too_large") ? "too_large" : reasons.length > 0 && reasons.every((reason) => reason === "ssrf_blocked" || reason === "domain_not_allowed") ? "ssrf_blocked" : "media_unavailable");

    stage("speech");
    const audio = media;
    let spoken: { text: string; language: string | null };
    try {
      spoken = await withTranscriptRetry(
        () => stt.transcribeAudio({ audio: new Uint8Array(audio.buffer), mimeType: audio.mimeType || "video/mp4", fileName: `tiktok-${info.videoId}.mp4`, languageHint: info.language }, { timeoutMs: TIKTOK_INTAKE_LIMITS.sttTimeoutMs }),
        this.retryOptions(),
      );
    } catch (error) {
      return this.fail("stt", error, info.videoId, stt.id);
    }

    stage("cleaning");
    const cleaned = cleanTranscript(spoken.text);
    if (!cleaned) return failure("transcript_empty");
    this.logger.log(`video ${info.videoId}: speech_to_text via ${source.id}+${stt.id} in ${this.now() - started} ms`);
    return this.done(cacheKey, info, { raw: spoken.text, cleaned, method: "speech_to_text", providerUsed: `${source.id}+${stt.id}`, language: twoLetter(spoken.language) ?? info.language });
  }

  /** What the provider returned, by field NAME and count only. */
  private logSource(info: TikTokVideoInfo, providerId: string, ms: number) {
    const d = info.diagnostics;
    if (!d) return;
    const subtitleFields = d.subtitleFields.length ? ` [${d.subtitleFields.join(", ")}]` : "";
    this.logger.log(`video ${info.videoId}: ${providerId} returned ${d.itemCount} item(s) in ${ms} ms; subtitles: ${d.subtitleTracks} track(s)${subtitleFields}; media: ${d.mediaFields.length ? d.mediaFields.join(", ") : "none"}`);
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

  /** A provider error -> its precise intake code; the log line carries the HTTP status / provider code / safe message, never a key. */
  private fail(phase: "source" | "stt", error: unknown, videoId: string, providerId: string): TikTokIntakeOutcome {
    const known = error instanceof TranscriptError ? error : null;
    const code = known ? (phase === "source" ? SOURCE_ERROR : STT_ERROR)[known.code] : phase === "source" ? "tiktok_provider_failed" : "stt_failed";
    const detail = known?.detail ?? {};
    const facts = [known?.code ?? "error", detail.httpStatus ? `HTTP ${detail.httpStatus}` : "", detail.providerCode ?? "", detail.itemCount !== undefined ? `items=${detail.itemCount}` : ""].filter(Boolean).join(", ");
    this.logger.warn(`video ${videoId}: ${phase === "source" ? "TikTok provider" : "speech-to-text"} ${providerId} failed (${facts})${detail.providerMessage ? `: ${detail.providerMessage}` : ""}`);
    return failure(code);
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
