import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ProviderError,
  createElevenLabsVoiceClone,
  deleteElevenLabsVoice,
  getElevenLabsVoice,
  listElevenLabsVoices,
  textToSpeechWithTimestamps,
} from "@lyonix/providers";
import { validateConsentEvidence, validateGeneratedAudio } from "@lyonix/domain";
import type { ErrorCode, ElevenLabsVoiceSummaryResponse, TtsGenerationResponse, UiLocale, VoiceCloneResultResponse } from "@lyonix/contracts";
import { PrismaService } from "./prisma.service.js";
import { MediaService } from "./media.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { writeQuarantineFile } from "./quarantine.js";

export type ElevenLabsOutcome<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

export type CloneConsentInput = { statementVersion: string; statementText: string; acceptedAt: string };
export type CloneSampleFileInput = { fileName: string; mimeType: string; base64Data: string };

const providerErrorMessage: Record<string, string> = {
  PROVIDER_AUTH_INVALID: "Khóa ElevenLabs bị từ chối. Verify lại tài khoản.",
  PROVIDER_QUOTA_EXHAUSTED: "Tài khoản ElevenLabs hết credit/quota.",
  PROVIDER_RATE_LIMITED: "ElevenLabs giới hạn tốc độ, thử lại sau.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Gói ElevenLabs hiện tại không hỗ trợ thao tác này (tier/entitlement).",
  PROVIDER_TIMEOUT: "Yêu cầu ElevenLabs hết thời gian chờ.",
  PROVIDER_SCHEMA_INVALID: "ElevenLabs trả về dữ liệu không hợp lệ.",
};

const mapProviderError = (error: unknown): { code: ErrorCode; message: string; status: number; retryable: boolean } => {
  if (error instanceof ProviderError) {
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED" || error.code === "PROVIDER_AUTH_INVALID";
    return { code: error.code, message: providerErrorMessage[error.code] ?? `ElevenLabs từ chối yêu cầu (${error.message})`, status: switchable ? 429 : 502, retryable: error.retryable };
  }
  return { code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi ElevenLabs", status: 502, retryable: true };
};

/**
 * Voice preview (create-video Voice Picker), used only when a voice has no provider `previewUrl`: one fixed short sentence per
 * language - the endpoint never speaks free text, so it cannot be used as a general (paid) TTS.
 */
export const VOICE_PREVIEW_SAMPLES: Record<UiLocale, string> = {
  vi: "Xin chào, đây là giọng đọc mẫu cho video của bạn.",
  en: "Hello, this is a sample of the voice for your video.",
  ja: "こんにちは。これはあなたの動画のためのサンプル音声です。",
  ko: "안녕하세요. 영상에 사용할 샘플 음성입니다.",
};
/** A synthesized preview is reused for a day (per account + voice + model + sentence), so replaying it never pays twice. */
export const VOICE_PREVIEW_CACHE = { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 200 } as const;

export type VoicePreviewAudio = { audio: Buffer; mimeType: string; cached: boolean; voiceId: string; modelId: string };

const consentValidationMessage: Record<string, string> = {
  missing_attestation: "Thiếu xác nhận consent (người xác nhận/thời điểm)",
  missing_statement: "Thiếu nội dung/version câu xác nhận consent",
  missing_samples: "Cần ít nhất một mẫu âm thanh cho voice clone",
};

@Injectable()
export class ElevenLabsVoiceService {
  private readonly previewCache = new Map<string, { at: number; audio: Buffer; mimeType: string }>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  /** Any non-deleted `elevenlabs`/`tts` account usable for generation — same authorization shape as `ScriptGenerationService`. */
  private async usableAccount(providerAccountId: string): Promise<ElevenLabsOutcome<{ id: string; model: string; encryptedSecret: string }>> {
    const account = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, deletedAt: null } });
    if (!account) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản provider không tồn tại hoặc đã bị xóa", status: 503 };
    if (account.role !== "tts" || account.provider !== "elevenlabs") {
      return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Tài khoản không phải ElevenLabs (tts)", status: 503 };
    }
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản ElevenLabs chưa verify", status: 503 };
    return { ok: true, data: { id: account.id, model: account.model, encryptedSecret: account.encryptedSecret } };
  }

  /**
   * A short spoken sample of `voiceId` with the account's own model - the same voice + model a render uses by default
   * (`generateTts` falls back to `account.model`). Cached; only called when the user presses Play on a voice without a
   * provider preview. Spends the account's credits, so the account must be one this user may use.
   */
  async previewVoice(providerAccountId: string, voiceId: string, userId: string, role: "admin" | "staff", language: UiLocale, now: number = Date.now()): Promise<ElevenLabsOutcome<VoicePreviewAudio>> {
    if (!/^[A-Za-z0-9]{4,64}$/.test(voiceId)) return { ok: false, code: "VALIDATION_FAILED", message: "voiceId không hợp lệ" };
    const text = VOICE_PREVIEW_SAMPLES[language] ?? VOICE_PREVIEW_SAMPLES.en;
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    if (role !== "admin") {
      const visible = await this.prisma.providerAccount.findFirst({ where: { id: providerAccountId, OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: userId }] }, select: { id: true } });
      if (!visible) return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy tài khoản giọng đọc", status: 404 };
    }
    const modelId = account.data.model;
    const key = createHash("sha256").update(["elevenlabs", providerAccountId, voiceId, modelId, text].join("\u0000")).digest("hex");
    const hit = this.previewCache.get(key);
    if (hit && now - hit.at < VOICE_PREVIEW_CACHE.ttlMs) {
      return { ok: true, data: { audio: hit.audio, mimeType: hit.mimeType, cached: true, voiceId, modelId } };
    }
    let synthesis: Awaited<ReturnType<typeof textToSpeechWithTimestamps>>;
    try {
      synthesis = await textToSpeechWithTimestamps(decryptSecret(account.data.encryptedSecret), { voiceId, modelId, text });
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
    const validated = validateGeneratedAudio({ buffer: synthesis.audio, declaredMimeType: synthesis.mimeType, alignmentDurationMs: synthesis.durationMs });
    if (!validated.ok) return { ok: false, code: "UNSUPPORTED_MEDIA", message: `Audio ElevenLabs trả về không hợp lệ (${validated.reason})`, status: 422 };
    this.previewCache.delete(key);
    this.previewCache.set(key, { at: now, audio: synthesis.audio, mimeType: validated.mimeType });
    while (this.previewCache.size > VOICE_PREVIEW_CACHE.maxEntries) {
      const oldest = this.previewCache.keys().next().value;
      if (oldest === undefined) break;
      this.previewCache.delete(oldest);
    }
    return { ok: true, data: { audio: synthesis.audio, mimeType: validated.mimeType, cached: false, voiceId, modelId } };
  }

  async listVoices(providerAccountId: string): Promise<ElevenLabsOutcome<ElevenLabsVoiceSummaryResponse[]>> {
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    try {
      return { ok: true, data: await listElevenLabsVoices(decryptSecret(account.data.encryptedSecret)) };
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
  }

  async getVoice(providerAccountId: string, voiceId: string): Promise<ElevenLabsOutcome<ElevenLabsVoiceSummaryResponse>> {
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    try {
      return { ok: true, data: await getElevenLabsVoice(decryptSecret(account.data.encryptedSecret), voiceId) };
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
  }

  /**
   * Consented Instant Voice Clone. The consent audit row is written with
   * `status:"pending"` *before* the provider is ever called; on success it is
   * updated to `created` with the returned `externalVoiceId`, on failure to
   * `failed` with a reason — either way there is a durable, queryable record that
   * this clone request happened, matching DEC-2026-09-24 §8 ("consent, evidence
   * reference and audit").
   */
  async createClone(
    providerAccountId: string,
    userId: string,
    input: { name: string; description?: string; consent: CloneConsentInput; files: CloneSampleFileInput[] },
  ): Promise<ElevenLabsOutcome<VoiceCloneResultResponse>> {
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    if (!input.name.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu tên voice clone" };
    if (input.files.length === 0) return { ok: false, code: "VALIDATION_FAILED", message: "Cần ít nhất một file mẫu âm thanh" };
    let decodedFiles: { fileName: string; mimeType: string; data: Buffer; checksum: string }[];
    try {
      decodedFiles = input.files.map((file) => {
        const data = Buffer.from(file.base64Data, "base64");
        if (data.length === 0) throw new Error("empty_sample");
        return { fileName: file.fileName, mimeType: file.mimeType, data, checksum: createHash("sha256").update(data).digest("hex") };
      });
    } catch {
      return { ok: false, code: "VALIDATION_FAILED", message: "File mẫu âm thanh không hợp lệ (base64 rỗng/sai định dạng)" };
    }
    const attestedAt = input.consent.acceptedAt?.trim() || new Date().toISOString();
    const consentEvidence = {
      attestedByUserId: userId,
      attestedAt,
      statementVersion: input.consent.statementVersion,
      statementText: input.consent.statementText,
      sampleChecksums: decodedFiles.map((f) => f.checksum),
    };
    const validation = validateConsentEvidence(consentEvidence);
    if (!validation.ok) return { ok: false, code: "VALIDATION_FAILED", message: consentValidationMessage[validation.reason] ?? "Consent không hợp lệ" };

    const consentRecord = await this.prisma.voiceCloneConsentRecord.create({
      data: {
        providerAccountId,
        voiceName: input.name.trim(),
        statementVersion: consentEvidence.statementVersion,
        statementText: consentEvidence.statementText,
        sampleChecksums: consentEvidence.sampleChecksums,
        status: "pending",
        attestedByUserId: userId,
        attestedAt: new Date(attestedAt),
      },
    });

    try {
      const result = await createElevenLabsVoiceClone(decryptSecret(account.data.encryptedSecret), {
        name: input.name.trim(),
        ...(input.description ? { description: input.description } : {}),
        files: decodedFiles.map(({ fileName, mimeType, data }) => ({ fileName, mimeType, data })),
        consent: consentEvidence,
      });
      await this.prisma.voiceCloneConsentRecord.update({ where: { id: consentRecord.id }, data: { status: "created", externalVoiceId: result.voiceId } });
      return { ok: true, data: { providerAccountId, voiceId: result.voiceId, name: input.name.trim(), consentRecordId: consentRecord.id } };
    } catch (error) {
      const mapped = mapProviderError(error);
      await this.prisma.voiceCloneConsentRecord.update({ where: { id: consentRecord.id }, data: { status: "failed", failureReason: mapped.code } });
      return { ok: false, ...mapped };
    }
  }

  /** Delete/revoke a voice at the provider and mark the matching consent record(s) revoked. */
  async deleteVoice(providerAccountId: string, voiceId: string, userId: string): Promise<ElevenLabsOutcome<{ deleted: true }>> {
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    try {
      await deleteElevenLabsVoice(decryptSecret(account.data.encryptedSecret), voiceId);
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
    await this.prisma.voiceCloneConsentRecord.updateMany({
      where: { providerAccountId, externalVoiceId: voiceId, revokedAt: null },
      data: { revokedAt: new Date(), revokedByUserId: userId, status: "revoked" },
    });
    return { ok: true, data: { deleted: true } };
  }

  /**
   * TTS-with-timestamps, validated and persisted as a working `MediaAssetVersion`
   * (kind `audio`, `origin:"generated"`) via the existing quarantine → project-asset
   * flow — reused as-is rather than inventing a second file-storage path. Alignment
   * timing itself is returned in the response, not persisted (that is VE2E-03's
   * `AudioVersion`/`SubtitleVersion` scope).
   */
  async generateTts(
    providerAccountId: string,
    userId: string,
    role: "admin" | "staff",
    input: { projectId: string; voiceId: string; text: string; modelId?: string; folderId?: string | null },
  ): Promise<ElevenLabsOutcome<TtsGenerationResponse>> {
    const account = await this.usableAccount(providerAccountId);
    if (!account.ok) return account;
    if (!input.text.trim()) return { ok: false, code: "VALIDATION_FAILED", message: "Thiếu nội dung text để tạo audio" };
    const modelId = input.modelId?.trim() || account.data.model;
    let synthesis: Awaited<ReturnType<typeof textToSpeechWithTimestamps>>;
    try {
      synthesis = await textToSpeechWithTimestamps(decryptSecret(account.data.encryptedSecret), { voiceId: input.voiceId, modelId, text: input.text });
    } catch (error) {
      return { ok: false, ...mapProviderError(error) };
    }
    const validated = validateGeneratedAudio({ buffer: synthesis.audio, declaredMimeType: synthesis.mimeType, alignmentDurationMs: synthesis.durationMs });
    if (!validated.ok) return { ok: false, code: "UNSUPPORTED_MEDIA", message: `Audio ElevenLabs trả về không hợp lệ (${validated.reason})`, status: 422 };

    const quarantined = await writeQuarantineFile(synthesis.audio);
    const originalFileName = `${randomUUID()}.mp3`;
    const registered = await this.media.registerAsset(input.projectId, userId, role, {
      quarantineToken: quarantined.quarantineToken,
      kind: "audio",
      originalFileName,
      mimeType: validated.mimeType,
      checksumSha256: validated.checksumSha256,
      bytes: validated.bytes,
      durationMs: validated.durationMs,
      origin: "generated",
      reusable: false,
      folderId: input.folderId ?? null,
    });
    if (registered === "forbidden") return { ok: false, code: "NOT_FOUND", message: "Không tìm thấy dự án", status: 404 };
    if (registered === "invalid" || registered === "unsupported_media" || registered === "quarantine_missing") {
      return { ok: false, code: "VALIDATION_FAILED", message: "Không thể lưu audio đã tạo vào project", status: 500 };
    }
    return {
      ok: true,
      data: {
        asset: registered,
        alignment: {
          characters: synthesis.alignment.characters,
          characterStartTimesSeconds: synthesis.alignment.characterStartTimesSeconds,
          characterEndTimesSeconds: synthesis.alignment.characterEndTimesSeconds,
        },
        durationMs: synthesis.durationMs,
        providerPin: { accountId: providerAccountId, provider: "elevenlabs", voiceId: input.voiceId, modelId },
      },
    };
  }
}
