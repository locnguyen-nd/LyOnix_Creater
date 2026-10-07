/**
 * VE2E-96: development stand-ins for the transcript providers (`TIKTOK_SOURCE_PROVIDER=mock`, `STT_PROVIDER=mock`). They return a fixed
 * sample and always report themselves as "mock", so a mocked transcript is never mistaken for a real one.
 */
import type { SpeechToTextInput, SpeechToTextProvider, SpeechToTextResult, TikTokVideoInfo, VideoTranscriptSource } from "./transcript-source.js";

export const MOCK_TIKTOK_SUBTITLES = `WEBVTT

00:00:00.000 --> 00:00:03.000
[MOCK] This is a sample transcript from the development provider.

00:00:03.000 --> 00:00:06.000
[MOCK] This is a sample transcript from the development provider.

00:00:06.000 --> 00:00:09.000
No real TikTok video was read: remove TIKTOK_SOURCE_PROVIDER=mock to use the Apify account from Provider Settings.
`;

export class MockVideoTranscriptSource implements VideoTranscriptSource {
  readonly id = "mock";

  constructor(private readonly options: { withSubtitles?: boolean } = {}) {}

  async resolveTikTok(url: string): Promise<TikTokVideoInfo> {
    const videoId = /\/video\/(\d+)/.exec(url)?.[1] ?? "7000000000000000000";
    return {
      videoId,
      url,
      author: "mock_author",
      caption: "[MOCK] sample caption",
      durationSec: 9,
      language: "en",
      subtitles: this.options.withSubtitles === false ? [] : [{ language: "en", text: MOCK_TIKTOK_SUBTITLES }],
      media: null,
    };
  }
}

export class MockSpeechToText implements SpeechToTextProvider {
  readonly id = "mock";

  async transcribeAudio(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    return { text: `[MOCK] Speech-to-text sample for ${input.fileName} (${input.audio.byteLength} bytes).`, language: "en" };
  }
}
