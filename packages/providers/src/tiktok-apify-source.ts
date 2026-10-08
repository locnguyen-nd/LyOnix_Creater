/**
 * VE2E-96: TikTok subtitles + video file through Apify's `clockworks/tiktok-scraper` (the Actor LyOnix already pins for TikTok media),
 * run for ONE post URL with subtitle and video download on. The Actor stores both in the run's Key-Value Store (api.apify.com, read
 * with the token); a subtitle may instead come as a TikTok CDN link. The output is untrusted: only https links on the allow-listed hosts
 * are kept, everything is clipped.
 *
 * Input (checked against the Actor's input schema, build 0.0.613, 2026-10-08): `postURLs`, `downloadSubtitlesOptions`
 * (`DOWNLOAD_SUBTITLES` stores the tracks; Apify's own paid transcription is NOT asked for - speech-to-text is ours).
 * Output seen on live runs (2026-10-06): `videoMeta.subtitleLinks[{language, downloadLink, tiktokLink, source}]`,
 * `videoMeta.downloadAddr` and `mediaUrls[]` (stored copies). Other Actor versions name the media differently, so every known media
 * field is read and tried in order (stored copy first), see TIKTOK_MEDIA_FIELDS.
 */
import { APIFY_ACTOR_ALLOWLIST, hostMatchesSuffix, runApifyActor, type ApifyDeps } from "./apify.js";
import { ProviderError } from "./index.js";
import { TranscriptError, type SubtitleTrack, type TikTokVideoInfo, type TranscriptDownload, type TranscriptErrorDetail, type VideoTranscriptSource } from "./transcript-source.js";

const APIFY_API_HOST = "api.apify.com";
/** Hosts a TikTok subtitle document may be served from without credentials. */
export const TIKTOK_SUBTITLE_HOSTS = ["tiktok.com", "tiktokcdn.com", "tiktokcdn-eu.com", "tiktokv.com"] as const;
/** TikTok's own media CDNs (a video link there is signed and short-lived; fetched without credentials). */
export const TIKTOK_MEDIA_HOSTS = ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "tiktokv.us", "tiktokv.eu"] as const;

/** Where a media link may sit in an item, best first. A value may be a string, an array of strings, or `{ url | urlList | url_list }`. */
export const TIKTOK_MEDIA_FIELDS: ReadonlyArray<readonly string[]> = [
  ["mediaUrls"],
  ["videoMeta", "downloadAddr"],
  ["videoMeta", "playAddr"],
  ["video", "downloadAddr"],
  ["video", "playAddr"],
  ["videoMeta", "videoUrl"],
  ["videoUrl"],
  ["downloadUrl"],
  ["playUrl"],
  ["video", "url"],
];
const SUBTITLE_FIELDS: ReadonlyArray<readonly string[]> = [["videoMeta", "subtitleLinks"], ["subtitleLinks"], ["video", "subtitleLinks"], ["videoMeta", "subtitles"]];
const MAX_MEDIA_CANDIDATES = 5;

type Json = Record<string, unknown>;
const isObj = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const at = (obj: unknown, ...path: readonly string[]): unknown => path.reduce<unknown>((cur, key) => (isObj(cur) ? cur[key] : undefined), obj);
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
/** A provider message made safe for a log line: no URL (signed links carry credentials), one line, clipped. */
const safeText = (value: unknown, max = 200): string => clip(value, 2000).replace(/https?:\/\/\S+/g, "<url>").slice(0, max);

const ISO3: Record<string, string> = { jpn: "ja", eng: "en", kor: "ko", vie: "vi", zho: "zh", cmn: "zh", chi: "zh", tha: "th", ind: "id", spa: "es", fra: "fr", deu: "de", por: "pt" };
/** "jpn-JP" / "ja-JP" / "en" -> "ja" / "ja" / "en". */
export const normalizeTikTokLanguage = (raw: unknown): string | null => {
  const text = clip(raw, 20).toLowerCase();
  if (!text) return null;
  const head = text.split(/[-_]/)[0]!;
  return ISO3[head] ?? (/^[a-z]{2}$/.test(head) ? head : null);
};

/** Actor input for ONE post: its URL, one result, subtitle tracks and the video file stored, no cover / slideshow / paid transcription. */
export function buildTikTokTranscriptInput(postUrl: string, language: string | null): Record<string, unknown> {
  return {
    postURLs: [postUrl],
    resultsPerPage: 1,
    downloadSubtitlesOptions: "DOWNLOAD_SUBTITLES",
    shouldDownloadVideos: true,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    proxyCountryCode: language === "ja" ? "JP" : "US",
  };
}

/** Every string link a media field holds (string, array, or a `{ url | urlList | url_list }` object). */
const linksIn = (value: unknown): unknown[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.slice(0, 3).flatMap((entry) => (typeof entry === "string" ? [entry] : isObj(entry) ? linksIn(entry) : []));
  if (isObj(value)) {
    const list = value.urlList ?? value.url_list;
    return [...(typeof value.url === "string" ? [value.url] : []), ...(Array.isArray(list) ? list.slice(0, 3).filter((entry) => typeof entry === "string") : [])];
  }
  return [];
};

/** Machine-translated tracks (`source: "MT"`) rank after the video's own captions. */
const isMachineTranslation = (link: Json) => clip(link.source, 10).toUpperCase() === "MT" || /translat/i.test(clip(link.sourceUnabbreviated, 60));

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

  // subtitles: the first field that holds a list, original captions before machine translations
  const subtitles: SubtitleTrack[] = [];
  const subtitleFields: string[] = [];
  for (const path of SUBTITLE_FIELDS) {
    const raw = at(item, ...path);
    if (!Array.isArray(raw) || raw.length === 0) continue;
    subtitleFields.push(path.join("."));
    const links = raw.slice(0, 20).filter(isObj).sort((a, b) => Number(isMachineTranslation(a)) - Number(isMachineTranslation(b)));
    for (const link of links) {
      const language = normalizeTikTokLanguage(link.language ?? link.languageCode ?? link.lang);
      const stored = kvFile(link.downloadLink ?? link.link);
      const cdn = httpsOn(link.tiktokLink ?? link.url ?? link.downloadLink, TIKTOK_SUBTITLE_HOSTS);
      if (stored) subtitles.push({ language, download: stored });
      else if (cdn) subtitles.push({ language, download: { url: cdn, hostSuffixes: [...TIKTOK_SUBTITLE_HOSTS] } });
    }
    break;
  }

  // media: every known field, stored copies (api.apify.com) before TikTok CDN links, deduplicated
  const stored: Array<{ field: string; file: TranscriptDownload }> = [];
  const cdn: Array<{ field: string; file: TranscriptDownload }> = [];
  for (const path of TIKTOK_MEDIA_FIELDS) {
    for (const raw of linksIn(at(item, ...path))) {
      const kv = kvFile(raw);
      if (kv) { stored.push({ field: path.join("."), file: kv }); continue; }
      const url = httpsOn(raw, TIKTOK_MEDIA_HOSTS);
      if (url) cdn.push({ field: path.join("."), file: { url, hostSuffixes: [...TIKTOK_MEDIA_HOSTS] } });
    }
  }
  const seen = new Set<string>();
  const media = [...stored, ...cdn].filter(({ file }) => (seen.has(file.url) ? false : (seen.add(file.url), true))).slice(0, MAX_MEDIA_CANDIDATES);

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
    media: media[0]?.file ?? null,
    mediaCandidates: media.map(({ file }) => file),
    diagnostics: { itemCount: 1, subtitleFields, subtitleTracks: subtitles.length, mediaFields: [...new Set(media.map(({ field }) => field))] },
  };
}

const fromProviderError = (error: ProviderError): TranscriptError => {
  const httpStatus = Number(/\((\d{3})\)/.exec(error.message)?.[1]) || (error.code === "PROVIDER_AUTH_INVALID" ? 401 : undefined);
  const detail: TranscriptErrorDetail = { providerCode: error.code, providerMessage: safeText(error.message), ...(httpStatus ? { httpStatus } : {}) };
  if (error.code === "PROVIDER_AUTH_INVALID") return new TranscriptError("auth_invalid", "Apify rejected the token", false, detail);
  if (error.code === "PROVIDER_QUOTA_EXHAUSTED") return new TranscriptError("quota_exhausted", "Apify account usage limit reached", false, detail);
  if (error.code === "PROVIDER_RATE_LIMITED") return new TranscriptError("rate_limited", "Apify rate limit reached", false, detail);
  if (error.code === "PROVIDER_TIMEOUT") return new TranscriptError("timeout", "Apify run timed out", true, detail);
  return new TranscriptError("unavailable", `Apify run failed (${error.code})`, error.retryable, detail);
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
    if (items.length === 0) throw new TranscriptError("empty_result", "Apify returned no item for this post", false, { itemCount: 0 });
    const expected = /\/video\/(\d+)/.exec(url)?.[1] ?? null;
    const videos = items.map((item) => parseTikTokTranscriptItem(item, this.token)).filter((video): video is TikTokVideoInfo => video !== null);
    const video = expected ? videos.find((candidate) => candidate.videoId === expected) : videos[0];
    if (!video) {
      const first = items[0];
      const itemError = isObj(first) ? safeText(first.error ?? first.errorDescription ?? first.errorCode) : "";
      throw new TranscriptError("not_found", "The TikTok video was not found (removed, private or not a video)", false, { itemCount: items.length, ...(itemError ? { providerMessage: itemError } : {}) });
    }
    return { ...video, diagnostics: { ...video.diagnostics!, itemCount: items.length } };
  }
}
