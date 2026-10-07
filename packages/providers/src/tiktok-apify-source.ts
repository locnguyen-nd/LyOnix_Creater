/**
 * VE2E-96: TikTok subtitles + video file through Apify's `clockworks/tiktok-scraper` (the Actor LyOnix already pins for TikTok media),
 * run for ONE post URL with subtitle and video download on. The Actor stores both in the run's Key-Value Store (api.apify.com, read
 * with the token); a subtitle may instead come as a TikTok CDN link. The output is untrusted: only https links on the allow-listed hosts
 * are kept, everything is clipped. The `postURLs` / `shouldDownloadSubtitles` input and the `subtitleLinks` output follow the Actor's
 * public documentation and have not been verified against a live run here.
 */
import { APIFY_ACTOR_ALLOWLIST, hostMatchesSuffix, runApifyActor, type ApifyDeps } from "./apify.js";
import { ProviderError } from "./index.js";
import { TranscriptError, type SubtitleTrack, type TikTokVideoInfo, type TranscriptDownload, type VideoTranscriptSource } from "./transcript-source.js";

const APIFY_API_HOST = "api.apify.com";
/** Hosts a TikTok subtitle document may be served from without credentials. */
export const TIKTOK_SUBTITLE_HOSTS = ["tiktok.com", "tiktokcdn.com", "tiktokcdn-eu.com", "tiktokv.com"] as const;

type Json = Record<string, unknown>;
const isObj = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const at = (obj: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, key) => (isObj(cur) ? cur[key] : undefined), obj);
// eslint-disable-next-line no-control-regex
const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : typeof value === "number" && Number.isFinite(value) ? String(value) : "");
const httpsOn = (raw: unknown, suffixes: readonly string[]): string => {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > 2048) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password && hostMatchesSuffix(url.hostname, suffixes) ? url.toString() : "";
  } catch {
    return "";
  }
};

const ISO3: Record<string, string> = { jpn: "ja", eng: "en", kor: "ko", vie: "vi", zho: "zh", cmn: "zh", chi: "zh", tha: "th", ind: "id", spa: "es", fra: "fr", deu: "de", por: "pt" };
/** "jpn-JP" / "ja-JP" / "en" -> "ja" / "ja" / "en". */
export const normalizeTikTokLanguage = (raw: unknown): string | null => {
  const text = clip(raw, 20).toLowerCase();
  if (!text) return null;
  const head = text.split(/[-_]/)[0]!;
  return ISO3[head] ?? (/^[a-z]{2}$/.test(head) ? head : null);
};

/** Actor input for ONE post: its URL, one result, subtitles and the video file stored, no cover / slideshow. */
export function buildTikTokTranscriptInput(postUrl: string, language: string | null): Record<string, unknown> {
  return {
    postURLs: [postUrl],
    resultsPerPage: 1,
    shouldDownloadSubtitles: true,
    shouldDownloadVideos: true,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    proxyCountryCode: language === "ja" ? "JP" : "US",
  };
}

/** One dataset item -> what the intake needs; null when it is not a usable video (error item, slideshow, no id). */
export function parseTikTokTranscriptItem(item: unknown, token: string): TikTokVideoInfo | null {
  if (!isObj(item) || item.error || item.errorCode || item.isSlideshow === true) return null;
  const videoId = clip(item.id, 40) || clip(at(item, "video", "id"), 40);
  if (!/^\d{8,25}$/.test(videoId)) return null;
  const auth = { host: APIFY_API_HOST, headers: { Authorization: `Bearer ${token}` } };
  const kvFile = (raw: unknown): TranscriptDownload | null => {
    const url = httpsOn(raw, [APIFY_API_HOST]);
    return url && new URL(url).pathname.startsWith("/v2/key-value-stores/") ? { url, hostSuffixes: [APIFY_API_HOST], scopedHeaders: auth } : null;
  };
  const rawLinks = at(item, "videoMeta", "subtitleLinks") ?? item.subtitleLinks ?? at(item, "video", "subtitleLinks");
  const subtitles: SubtitleTrack[] = [];
  for (const link of Array.isArray(rawLinks) ? rawLinks.slice(0, 20) : []) {
    if (!isObj(link)) continue;
    const language = normalizeTikTokLanguage(link.language ?? link.languageCode ?? link.lang);
    const stored = kvFile(link.downloadLink ?? link.link);
    const cdn = httpsOn(link.tiktokLink ?? link.url, TIKTOK_SUBTITLE_HOSTS);
    if (stored) subtitles.push({ language, download: stored });
    else if (cdn) subtitles.push({ language, download: { url: cdn, hostSuffixes: [...TIKTOK_SUBTITLE_HOSTS] } });
  }
  const author = clip(at(item, "authorMeta", "name"), 100) || clip(at(item, "authorMeta", "nickName"), 100) || null;
  const pageUrl = httpsOn(item.webVideoUrl ?? item.postPage, ["tiktok.com"]);
  const duration = Number(at(item, "videoMeta", "duration"));
  return {
    videoId,
    url: pageUrl || `https://www.tiktok.com/@${author ?? "_"}/video/${videoId}`,
    author,
    caption: clip(item.text ?? item.title, 2200) || null,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    language: normalizeTikTokLanguage(item.textLanguage),
    subtitles,
    media: kvFile(Array.isArray(item.mediaUrls) ? item.mediaUrls[0] : undefined),
  };
}

const fromProviderError = (error: ProviderError): TranscriptError => {
  if (error.code === "PROVIDER_AUTH_INVALID") return new TranscriptError("auth_invalid", "Apify rejected the token");
  if (error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED") return new TranscriptError("rate_limited", "Apify rate limit / quota reached", false);
  if (error.code === "PROVIDER_TIMEOUT") return new TranscriptError("timeout", "Apify run timed out", true);
  return new TranscriptError("unavailable", `Apify run failed (${error.code})`, error.retryable);
};

export class ApifyTikTokTranscriptSource implements VideoTranscriptSource {
  readonly id = "apify";

  constructor(private readonly token: string, private readonly deps?: ApifyDeps) {}

  async resolveTikTok(url: string, options: { language?: string | null; timeoutSecs: number }): Promise<TikTokVideoInfo> {
    let items: unknown[];
    try {
      ({ items } = await runApifyActor(this.token, APIFY_ACTOR_ALLOWLIST.tiktok.primary, buildTikTokTranscriptInput(url, options.language ?? null), 1, { timeoutSecs: options.timeoutSecs }, this.deps));
    } catch (error) {
      if (error instanceof ProviderError) throw fromProviderError(error);
      throw new TranscriptError("unavailable", "Apify run failed", true);
    }
    const expected = /\/video\/(\d+)/.exec(url)?.[1] ?? null;
    const videos = items.map((item) => parseTikTokTranscriptItem(item, this.token)).filter((video): video is TikTokVideoInfo => video !== null);
    const video = expected ? videos.find((candidate) => candidate.videoId === expected) : videos[0];
    if (!video) throw new TranscriptError("not_found", "The TikTok video was not found (removed, private or not a video)");
    return video;
  }
}
