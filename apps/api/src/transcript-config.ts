/**
 * VE2E-96: which transcript providers the URL intake uses - configuration only (never chosen by the UI), keys only from the environment:
 *  TIKTOK_SOURCE_PROVIDER = apify | mock   (apify needs TIKTOK_APIFY_TOKEN)
 *  STT_PROVIDER           = elevenlabs | mock   (elevenlabs needs ELEVENLABS_STT_API_KEY; ELEVENLABS_STT_MODEL optional)
 * Anything else / a missing key = not configured (the intake says so; nothing is faked).
 */
import { ApifyTikTokTranscriptSource, ELEVENLABS_STT_DEFAULT_MODEL, ElevenLabsSpeechToText, MockSpeechToText, MockVideoTranscriptSource, type SpeechToTextProvider, type VideoTranscriptSource } from "@lyonix/providers";

export type TranscriptProviders = { video: VideoTranscriptSource | null; stt: SpeechToTextProvider | null };

export function transcriptProvidersFromEnv(env: Record<string, string | undefined> = process.env): TranscriptProviders {
  const videoKind = (env.TIKTOK_SOURCE_PROVIDER ?? "").trim().toLowerCase();
  const sttKind = (env.STT_PROVIDER ?? "").trim().toLowerCase();
  const apifyToken = (env.TIKTOK_APIFY_TOKEN ?? "").trim();
  const sttKey = (env.ELEVENLABS_STT_API_KEY ?? "").trim();
  const video = videoKind === "apify" && apifyToken ? new ApifyTikTokTranscriptSource(apifyToken) : videoKind === "mock" ? new MockVideoTranscriptSource() : null;
  const stt = sttKind === "elevenlabs" && sttKey ? new ElevenLabsSpeechToText(sttKey, (env.ELEVENLABS_STT_MODEL ?? "").trim() || ELEVENLABS_STT_DEFAULT_MODEL) : sttKind === "mock" ? new MockSpeechToText() : null;
  return { video, stt };
}
