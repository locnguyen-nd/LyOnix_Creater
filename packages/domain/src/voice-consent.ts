/**
 * VE2E-02 / DEC-2026-09-24 §8: voice cloning must have an explicit consent
 * attestation, an evidence reference and an audit trail before any Instant Voice
 * Clone request is made. This module is the pure guard/statement-builder shared by
 * the ElevenLabs provider client and the API layer that persists the audit record —
 * neither of them may call the clone API without this evidence.
 */

export const VOICE_CONSENT_STATEMENT_VERSION = "v1";

export type ConsentEvidence = {
  attestedByUserId: string;
  attestedAt: string;
  statementVersion: string;
  statementText: string;
  /** sha256 of each uploaded sample file — never the raw audio bytes. */
  sampleChecksums: string[];
};

/**
 * The exact attestation text the user must have agreed to (checkbox in UI, or
 * equivalent) before a clone request can be submitted. Versioned so a future wording
 * change does not retroactively alter what an earlier consent record means.
 */
export const buildVoiceConsentStatement = (voiceName: string): string =>
  `Tôi xác nhận tôi có quyền hợp pháp sử dụng mẫu giọng nói đã tải lên để tạo voice clone "${voiceName}" trong LyOnix, và tôi đồng ý cho nhà cung cấp xử lý mẫu âm thanh này theo điều khoản dịch vụ của họ.`;

export type ConsentValidationResult = { ok: true } | { ok: false; reason: "missing_attestation" | "missing_statement" | "missing_samples" };

/** Pure check — does not throw, so callers can choose how to surface the failure (HTTP 400 vs internal guard). */
export const validateConsentEvidence = (consent: Partial<ConsentEvidence> | null | undefined): ConsentValidationResult => {
  if (!consent?.attestedByUserId?.trim() || !consent.attestedAt?.trim()) return { ok: false, reason: "missing_attestation" };
  if (!consent.statementVersion?.trim() || !consent.statementText?.trim()) return { ok: false, reason: "missing_statement" };
  if (!Array.isArray(consent.sampleChecksums) || consent.sampleChecksums.length === 0) return { ok: false, reason: "missing_samples" };
  return { ok: true };
};

/** Throwing variant for call sites that want a hard guard (fail fast, never call the provider without consent). */
export function assertConsentEvidence(consent: Partial<ConsentEvidence> | null | undefined): asserts consent is ConsentEvidence {
  const result = validateConsentEvidence(consent);
  if (!result.ok) throw new Error(`voice_clone_consent_${result.reason}`);
}
