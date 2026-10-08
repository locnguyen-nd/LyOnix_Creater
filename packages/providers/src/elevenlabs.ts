/**
 * VE2E-02: real ElevenLabs adapter — list/preview voices, consented Instant Voice
 * Clone, delete/revoke voice and TTS-with-timestamps. No fake/local fallback: every
 * function here makes a real HTTP call (or throws before doing so, e.g. missing
 * consent) and normalizes failures to `ProviderError`. Tests inject `fetch` via
 * `vi.stubGlobal` (same pattern as `live-content.ts`) — this module never decides to
 * skip the network call at runtime.
 */
import { ProviderError } from "./index.js";

/** Curated, human-reviewed default TTS model set (mirrors `CURATED_CONTENT_MODELS` for content providers). */
export const CURATED_ELEVENLABS_MODELS = ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5"] as const;

const API_BASE = "https://api.elevenlabs.io";
const timeoutMs = 120_000;

/** Redacts an ElevenLabs API key (`xi-api-key`, no fixed prefix) if it leaks into an error body. */
const redact = (value: string) => value.replace(/[a-f0-9]{32}/gi, "[redacted]").slice(0, 220);

type ElevenLabsErrorDetail = { status?: string; message?: string } | string | undefined;

const detailOf = (body: Record<string, unknown>): ElevenLabsErrorDetail => body.detail as ElevenLabsErrorDetail;

const messageOf = (detail: ElevenLabsErrorDetail): string =>
  typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : "";

const statusOf = (detail: ElevenLabsErrorDetail): string => (typeof detail === "object" ? detail?.status ?? "" : "");

/**
 * Normalizes an ElevenLabs error response to `ProviderError`. Distinguishes a *tier/
 * entitlement* gap (e.g. Instant Voice Clone or a model not included in the caller's
 * subscription) from a plain auth failure, because the two need different operator
 * remediation — both map to `PROVIDER_CAPABILITY_UNAVAILABLE` (tier) vs
 * `PROVIDER_AUTH_INVALID` (bad key) per the normalized provider error contract.
 */
const fail = (status: number, retryAfter: string | null, body: Record<string, unknown>): never => {
  const detail = detailOf(body);
  const message = messageOf(detail) || (typeof body.message === "string" ? body.message : "");
  const code = statusOf(detail);
  const suffix = message || code ? `: ${redact(`${code} ${message}`.trim())}` : "";
  const quota = /quota_exceeded|insufficient|credits|character.?limit/i.test(`${code} ${message}`);
  const tierGap = /voice_limit_reached|can_not_use_instant_voice_cloning|professional_voice|missing_permissions|not_allowed|requires? (a )?higher tier|upgrade your (plan|subscription)/i.test(`${code} ${message}`);
  if (quota) throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", `ElevenLabs quota exhausted${suffix}`, false);
  if (status === 403 || tierGap) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `ElevenLabs account tier does not include this capability${suffix}`, false);
  if (status === 401) throw new ProviderError("PROVIDER_AUTH_INVALID", `ElevenLabs authentication failed${suffix}`, false);
  if (status === 429) throw new ProviderError("PROVIDER_RATE_LIMITED", `ElevenLabs rate limit reached${suffix}`, true, Number(retryAfter ?? 0) * 1000 || undefined);
  if (status === 400 || status === 422) throw new ProviderError("PROVIDER_SCHEMA_INVALID", `ElevenLabs rejected the request${suffix}`, false);
  if (status === 404) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", `ElevenLabs voice or model not found${suffix}`, false);
  throw new ProviderError("PROVIDER_UNAVAILABLE", `ElevenLabs request failed (${status})${suffix}`, status >= 500);
};

const timedFetch = (path: string, apiKey: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), "xi-api-key": apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  });

async function call(path: string, apiKey: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await timedFetch(path, apiKey, init);
  } catch {
    throw new ProviderError("PROVIDER_TIMEOUT", "ElevenLabs request timed out or network failed", true);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) fail(response.status, response.headers.get("retry-after"), body);
  return body;
}

// --- account/model preflight ---

export type ElevenLabsAccountInfo = { tier: string | null; characterCount: number | null; characterLimit: number | null; canUseInstantVoiceCloning: boolean };

/**
 * Lightweight, non-billed account probe (`GET /v1/user`). This is the "account"
 * half of the operation-specific preflight — it proves the key works and reports
 * subscription/entitlement, but a real TTS or clone call is still the only way to
 * prove a *specific* voice/model is usable (see `probeElevenLabsTts` below).
 */
export async function probeElevenLabsAccount(apiKey: string): Promise<ElevenLabsAccountInfo> {
  const body = await call("/v1/user", apiKey);
  const subscription = (body.subscription ?? {}) as Record<string, unknown>;
  return {
    tier: typeof subscription.tier === "string" ? subscription.tier : null,
    characterCount: typeof subscription.character_count === "number" ? subscription.character_count : null,
    characterLimit: typeof subscription.character_limit === "number" ? subscription.character_limit : null,
    canUseInstantVoiceCloning: subscription.can_use_instant_voice_cloning !== false,
  };
}

// --- list/preview voices ---

/** One language a voice is verified for, with that language's own provider preview (if any). */
export type ElevenLabsVoiceLanguage = { language: string; accent: string | null; locale: string | null; modelId: string | null; previewUrl: string | null };

export type ElevenLabsVoiceSummary = {
  voiceId: string;
  name: string;
  category: string | null;
  previewUrl: string | null;
  /** From the voice's `labels` (search / filter metadata; null when the provider has none). */
  gender: string | null;
  language: string | null;
  accent: string | null;
  age: string | null;
  useCase: string | null;
  descriptive: string | null;
  /** `verified_languages`: the languages the voice is verified to speak, each with its own preview when ElevenLabs has one. */
  languages: ElevenLabsVoiceLanguage[];
};

const text = (value: unknown, max = 60): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
/** Only https provider links are passed on as previews (never a data: / http: URL from an untrusted body). */
const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
};

const toVoiceSummary = (row: Record<string, unknown>): ElevenLabsVoiceSummary => {
  const labels = (row.labels && typeof row.labels === "object" ? row.labels : {}) as Record<string, unknown>;
  const verified = Array.isArray(row.verified_languages) ? (row.verified_languages as Array<Record<string, unknown>>) : [];
  return {
    voiceId: String(row.voice_id ?? ""),
    name: String(row.name ?? ""),
    category: typeof row.category === "string" ? row.category : null,
    previewUrl: httpsUrl(row.preview_url),
    gender: text(labels.gender, 20),
    language: text(labels.language, 10),
    accent: text(labels.accent, 40),
    age: text(labels.age, 20),
    useCase: text(labels.use_case, 40),
    descriptive: text(labels.descriptive, 40),
    languages: verified.slice(0, 60).flatMap((entry) => {
      const language = text(entry.language, 10);
      return language ? [{ language, accent: text(entry.accent, 40), locale: text(entry.locale, 20), modelId: text(entry.model_id, 60), previewUrl: httpsUrl(entry.preview_url) }] : [];
    }),
  };
};

export async function listElevenLabsVoices(apiKey: string): Promise<ElevenLabsVoiceSummary[]> {
  const body = await call("/v1/voices", apiKey);
  const voices = Array.isArray(body.voices) ? (body.voices as Array<Record<string, unknown>>) : [];
  return voices.map(toVoiceSummary);
}

/**
 * Voice detail/preview — returns the provider's own short-lived `preview_url`
 * (an ElevenLabs CDN link), never audio bytes fetched or logged by this server.
 */
export async function getElevenLabsVoice(apiKey: string, voiceId: string): Promise<ElevenLabsVoiceSummary> {
  const body = await call(`/v1/voices/${encodeURIComponent(voiceId)}`, apiKey);
  return toVoiceSummary(body);
}

// --- consented Instant Voice Clone ---

/**
 * Evidence that must exist *before* this module ever calls ElevenLabs' clone
 * endpoint. Mirrors `@lyonix/domain` `ConsentEvidence` shape but is re-declared
 * here (no framework/domain dependency in the provider client) and validated
 * independently — defense in depth so a caller cannot bypass consent by only
 * satisfying the domain-layer guard.
 */
export type VoiceCloneConsentEvidence = {
  attestedByUserId: string;
  attestedAt: string;
  statementVersion: string;
  statementText: string;
};

export type VoiceCloneSampleFile = { fileName: string; mimeType: string; data: Buffer };

export type CreateVoiceCloneInput = {
  name: string;
  description?: string;
  files: VoiceCloneSampleFile[];
  consent: VoiceCloneConsentEvidence;
};

const hasConsent = (consent: VoiceCloneConsentEvidence | null | undefined): consent is VoiceCloneConsentEvidence =>
  Boolean(consent?.attestedByUserId?.trim() && consent?.attestedAt?.trim() && consent?.statementVersion?.trim() && consent?.statementText?.trim());

/**
 * Instant Voice Clone (`POST /v1/voices/add`). Refuses to call the provider at all
 * when `consent` is missing/incomplete or no sample file was provided — this is a
 * hard local guard, not something the provider enforces for us.
 */
export async function createElevenLabsVoiceClone(apiKey: string, input: CreateVoiceCloneInput): Promise<{ voiceId: string }> {
  if (!hasConsent(input.consent)) throw new Error("voice_clone_consent_missing");
  if (!input.name.trim()) throw new Error("voice_clone_name_missing");
  if (input.files.length === 0) throw new Error("voice_clone_sample_missing");
  const form = new FormData();
  form.set("name", input.name.trim());
  if (input.description?.trim()) form.set("description", input.description.trim());
  for (const file of input.files) {
    form.append("files", new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.fileName);
  }
  const body = await call("/v1/voices/add", apiKey, { method: "POST", body: form });
  const voiceId = typeof body.voice_id === "string" ? body.voice_id : "";
  if (!voiceId) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "ElevenLabs did not return a voice_id for the clone", false);
  return { voiceId };
}

/** Delete/revoke a voice (`DELETE /v1/voices/:voice_id`). Idempotent from the caller's perspective. */
export async function deleteElevenLabsVoice(apiKey: string, voiceId: string): Promise<void> {
  await call(`/v1/voices/${encodeURIComponent(voiceId)}`, apiKey, { method: "DELETE" });
}

// --- TTS with timestamps ---

export type TtsAlignment = { characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] };
export type TtsWithTimestampsResult = { audio: Buffer; mimeType: string; alignment: TtsAlignment; durationMs: number };

export type TextToSpeechInput = { voiceId: string; modelId: string; text: string; outputFormat?: string };

const parseAlignment = (raw: unknown): TtsAlignment => {
  const value = (raw ?? {}) as Record<string, unknown>;
  const characters = Array.isArray(value.characters) ? value.characters.map(String) : [];
  const start = Array.isArray(value.character_start_times_seconds) ? value.character_start_times_seconds.map(Number) : [];
  const end = Array.isArray(value.character_end_times_seconds) ? value.character_end_times_seconds.map(Number) : [];
  return { characters, characterStartTimesSeconds: start, characterEndTimesSeconds: end };
};

/** ElevenLabs default TTS output container is MP3 (`mp3_44100_128`) unless `outputFormat` overrides it. */
const mimeForOutputFormat = (outputFormat: string | undefined): string => {
  if (outputFormat?.startsWith("pcm")) return "audio/wav";
  if (outputFormat?.startsWith("ulaw")) return "audio/basic";
  return "audio/mpeg";
};

/**
 * `POST /v1/text-to-speech/:voice_id/with-timestamps` — returns base64 audio plus a
 * character-level alignment. Duration is derived from the alignment's last
 * character end time (no FFmpeg/binary duration parsing in the API process, per
 * the hard rule that FFmpeg only runs in `apps/media-worker`).
 */
export async function textToSpeechWithTimestamps(apiKey: string, input: TextToSpeechInput): Promise<TtsWithTimestampsResult> {
  if (!input.text.trim()) throw new Error("tts_text_missing");
  const body = await call(`/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/with-timestamps`, apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: input.text,
      model_id: input.modelId,
      ...(input.outputFormat ? {} : {}),
    }),
  });
  const audioBase64 = typeof body.audio_base64 === "string" ? body.audio_base64 : "";
  if (!audioBase64) throw new ProviderError("PROVIDER_SCHEMA_INVALID", "ElevenLabs did not return audio_base64", false);
  const alignment = parseAlignment(body.alignment);
  if (alignment.characters.length === 0 || alignment.characterEndTimesSeconds.length !== alignment.characters.length) {
    throw new ProviderError("PROVIDER_SCHEMA_INVALID", "ElevenLabs did not return a usable character alignment", false);
  }
  const durationMs = Math.round(Math.max(...alignment.characterEndTimesSeconds, 0) * 1000);
  return { audio: Buffer.from(audioBase64, "base64"), mimeType: mimeForOutputFormat(input.outputFormat), alignment, durationMs };
}

/**
 * Operation-specific TTS preflight: a real, minimal `with-timestamps` call on the
 * exact voice/model pair (same "verify on the real generate endpoint" principle as
 * `probeContentModel`). This *does* consume a small amount of ElevenLabs character
 * quota — callers should use it sparingly (e.g. once per new voice/model pin), not
 * on every request.
 */
export async function probeElevenLabsTts(apiKey: string, voiceId: string, modelId: string): Promise<{ verifiedAt: string }> {
  await textToSpeechWithTimestamps(apiKey, { voiceId, modelId, text: "Xin chào." });
  return { verifiedAt: new Date().toISOString() };
}
