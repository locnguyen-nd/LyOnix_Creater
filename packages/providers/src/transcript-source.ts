/**
 * VE2E-96: transcript providers for the create-video page's URL intake. Two replaceable roles, each picked by configuration (never by the UI):
 *  - VideoTranscriptSource: what a platform exposes for one video - its subtitle tracks and a media file (e.g. Apify's TikTok scraper);
 *  - SpeechToTextProvider: audio / video bytes -> text (e.g. ElevenLabs Scribe), used when a video has no subtitle.
 * Files are never fetched here: a source returns download PLANS (URL, allowed hosts, host-scoped auth header) that the API downloads
 * through its SSRF-safe fetch. Errors are TranscriptError with a stable code; messages never carry a key or token.
 */

export type TranscriptErrorCode = "not_configured" | "not_found" | "timeout" | "rate_limited" | "auth_invalid" | "unavailable" | "unsupported_media";

export class TranscriptError extends Error {
  constructor(readonly code: TranscriptErrorCode, message: string, readonly retryable = false) {
    super(message);
  }
}

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
  /** The video file to transcribe when no subtitle can be used; null = none available. */
  media: TranscriptDownload | null;
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
