/**
 * VE2E-96: speech-to-text with ElevenLabs Scribe (`POST /v1/speech-to-text`, multipart: `model_id` + `file`; audio and video files are
 * accepted). The key comes from configuration (`ELEVENLABS_STT_API_KEY`) and is only ever sent in the `xi-api-key` header.
 */
import { TranscriptError, type SpeechToTextInput, type SpeechToTextProvider, type SpeechToTextResult, type TranscriptErrorDetail } from "./transcript-source.js";

export const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const ELEVENLABS_STT_DEFAULT_MODEL = "scribe_v1";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: FormData; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class ElevenLabsSpeechToText implements SpeechToTextProvider {
  readonly id = "elevenlabs_scribe";

  constructor(private readonly apiKey: string, private readonly model: string = ELEVENLABS_STT_DEFAULT_MODEL, private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  async transcribeAudio(input: SpeechToTextInput, options: { timeoutMs: number }): Promise<SpeechToTextResult> {
    const form = new FormData();
    form.set("model_id", this.model);
    // copy into a plain ArrayBuffer (a Uint8Array may view a SharedArrayBuffer, which Blob does not take)
    form.set("file", new Blob([new Uint8Array(input.audio).buffer as ArrayBuffer], { type: input.mimeType }), input.fileName);
    form.set("tag_audio_events", "false");
    form.set("diarize", "false");
    if (input.languageHint && /^[a-z]{2,3}$/.test(input.languageHint)) form.set("language_code", input.languageHint);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(ELEVENLABS_STT_URL, { method: "POST", headers: { "xi-api-key": this.apiKey }, body: form, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TranscriptError(timedOut ? "timeout" : "unavailable", timedOut ? `speech-to-text did not answer within ${options.timeoutMs} ms` : "speech-to-text request failed", true);
    }
    if (!response.ok) {
      // ElevenLabs puts its reason in `detail.status` (quota_exceeded, invalid_api_key, missing_permissions, ...): a short code, safe to log.
      const body = (await response.json().catch(() => null)) as { detail?: { status?: unknown } } | null;
      const reason = typeof body?.detail?.status === "string" ? body.detail.status.replace(/[^a-z0-9_]/gi, "").slice(0, 40) : "";
      const detail: TranscriptErrorDetail = { httpStatus: response.status, ...(reason ? { providerCode: reason } : {}) };
      if (response.status === 402 || /quota|credit/i.test(reason)) throw new TranscriptError("quota_exhausted", "ElevenLabs speech-to-text credits are used up", false, detail);
      if (response.status === 401 || response.status === 403) throw new TranscriptError("auth_invalid", "ElevenLabs rejected the speech-to-text key (or it lacks the speech-to-text permission)", false, detail);
      if (response.status === 429) throw new TranscriptError("rate_limited", "ElevenLabs speech-to-text rate limit reached", false, detail);
      if (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422) throw new TranscriptError("unsupported_media", `ElevenLabs could not transcribe this file (HTTP ${response.status})`, false, detail);
      throw new TranscriptError("unavailable", `ElevenLabs speech-to-text failed (HTTP ${response.status})`, response.status >= 500, detail);
    }
    const body = (await response.json().catch(() => null)) as { text?: unknown; language_code?: unknown } | null;
    return {
      text: typeof body?.text === "string" ? body.text : "",
      language: typeof body?.language_code === "string" ? body.language_code.slice(0, 8) : null,
    };
  }
}
