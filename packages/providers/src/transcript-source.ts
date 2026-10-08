/**
 * VE2E-96: transcript providers for the create-video page's URL intake. Two replaceable roles, each picked by configuration (never by the UI):
 *  - VideoTranscriptSource: what a platform exposes for one video - its subtitle tracks and a media file (e.g. Apify's TikTok scraper);
 *  - SpeechToTextProvider: audio / video bytes -> text (e.g. ElevenLabs Scribe), used when a video has no subtitle.
 * Files are never fetched here: a source returns download PLANS (URL, allowed hosts, host-scoped auth header) that the API downloads
 * through its SSRF-safe fetch. Errors are TranscriptError with a stable code; messages never carry a key or token.
 */

export type TranscriptErrorCode =
  | "not_configured"
  | "not_found"
  | "timeout"
  | "rate_limited"
  | "quota_exhausted"
  | "auth_invalid"
  | "unavailable"
  | "unsupported_media"
  /** The provider answered but returned no item at all for the video. */
  | "empty_result";

/** Safe facts for logs: HTTP status, the provider's own error code and its (token-redacted, URL-free, clipped) message. */
export type TranscriptErrorDetail = { httpStatus?: number; providerCode?: string; providerMessage?: string; itemCount?: number };

export class TranscriptError extends Error {
  constructor(readonly code: TranscriptErrorCode, message: string, readonly retryable = false, readonly detail: TranscriptErrorDetail = {}) {
    super(message);
  }
}

/** What a source run returned, as field NAMES and counts only (never a URL, token or text) - for the intake log. */
export type TranscriptSourceDiagnostics = {
  itemCount: number;
  /** e.g. ["videoMeta.subtitleLinks"] - where subtitle tracks were found. */
  subtitleFields: string[];
  subtitleTracks: number;
  /** e.g. ["mediaUrls", "videoMeta.downloadAddr"] - every field that held a usable media link, in the order they are tried. */
  mediaFields: string[];
};

/** A file the API downloads with `fetchBinarySafely`: only from these hosts; `scopedHeaders` go to that one host only. */
export type TranscriptDownload = { url: string; hostSuffixes: readonly string[]; scopedHeaders?: { host: string; headers: Record<string, string> } };

/** A subtitle track: a document to download, or its text when the source already has it. */
export type SubtitleTrack = { language: string | null; download?: TranscriptDownload; text?: string };

export type TikTokVideoInfo = {
  videoId: string;
  url: string;
  author: string | null;
  /** The post's own caption (description), not speech. */
  caption: string | null;
  durationSec: number | null;
  language: string | null;
  subtitles: SubtitleTrack[];
  /** The video file to transcribe when no subtitle can be used; null = none available. Same as `mediaCandidates[0]`. */
  media: TranscriptDownload | null;
  /** Every usable media file, best first (the provider's stored copy before a platform CDN link); tried in order until one downloads. */
  mediaCandidates?: TranscriptDownload[];
  diagnostics?: TranscriptSourceDiagnostics;
};

export interface VideoTranscriptSource {
  readonly id: string;
  resolveTikTok(url: string, options: { language?: string | null; timeoutSecs: number }): Promise<TikTokVideoInfo>;
}

export type SpeechToTextInput = { audio: Uint8Array; mimeType: string; fileName: string; languageHint?: string | null };
export type SpeechToTextResult = { text: string; language: string | null };

export interface SpeechToTextProvider {
  readonly id: string;
  transcribeAudio(input: SpeechToTextInput, options: { timeoutMs: number }): Promise<SpeechToTextResult>;
}

/** Runs `call`; a retryable TranscriptError is tried once more after `delayMs`. */
export async function withTranscriptRetry<T>(call: () => Promise<T>, options: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const retries = options.retries ?? 1;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof TranscriptError) || !error.retryable || attempt >= retries) throw error;
      await sleep(options.delayMs ?? 1500);
    }
  }
}
