import type { VoiceCloneConsentRequest, VoiceCloneSampleFileInput } from "@lyonix/contracts";

/** Same numbers as the API (`apps/api/src/voice-clone-limits.ts`): the server re-checks them, this only saves a round trip. */
export const VOICE_CLONE_LIMITS = { maxFiles: 5, maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxNameLength: 60 } as const;
/** Bump when the consent wording changes: the exact text shown is stored with the clone's audit record. */
export const VOICE_CLONE_CONSENT_VERSION = "voice-clone-consent-v1";

export type SampleProblem = "tooMany" | "notAudio" | "fileTooLarge" | "totalTooLarge";
type SampleLike = { name: string; size: number; type: string };

const AUDIO_EXTENSION = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i;

/** Browsers leave `type` empty for some audio files, so a known extension counts as audio too. */
export const isAudioSample = (file: SampleLike): boolean => file.type.toLowerCase().startsWith("audio/") || (file.type === "" && AUDIO_EXTENSION.test(file.name));

export function checkSamples(files: readonly SampleLike[]): SampleProblem | null {
  if (files.length > VOICE_CLONE_LIMITS.maxFiles) return "tooMany";
  if (files.some((file) => !isAudioSample(file))) return "notAudio";
  if (files.some((file) => file.size > VOICE_CLONE_LIMITS.maxFileBytes)) return "fileTooLarge";
  if (files.reduce((sum, file) => sum + file.size, 0) > VOICE_CLONE_LIMITS.maxTotalBytes) return "totalTooLarge";
  return null;
}

export const formatBytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** mime for the API: the file's own, else guessed from the extension (the server only accepts `audio/*`). */
export const sampleMimeType = (file: SampleLike): string => {
  if (file.type.toLowerCase().startsWith("audio/")) return file.type;
  const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  const byExt: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", webm: "audio/webm" };
  return byExt[ext] ?? "audio/mpeg";
};

const readBase64 = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });

export async function toSampleInputs(files: readonly File[]): Promise<VoiceCloneSampleFileInput[]> {
  return Promise.all(files.map(async (file) => ({ fileName: file.name, mimeType: sampleMimeType(file), base64Data: await readBase64(file) })));
}

export const buildConsent = (statementText: string, now: Date = new Date()): VoiceCloneConsentRequest => ({
  statementVersion: VOICE_CLONE_CONSENT_VERSION,
  statementText,
  acceptedAt: now.toISOString(),
});
