import { describe, expect, it } from "vitest";
import { assertConsentEvidence, buildVoiceConsentStatement, validateConsentEvidence, VOICE_CONSENT_STATEMENT_VERSION } from "./voice-consent.js";

const validConsent = {
  attestedByUserId: "user-1",
  attestedAt: "2026-09-24T00:00:00.000Z",
  statementVersion: VOICE_CONSENT_STATEMENT_VERSION,
  statementText: buildVoiceConsentStatement("My Voice"),
  sampleChecksums: ["a".repeat(64)],
};

describe("buildVoiceConsentStatement", () => {
  it("includes the voice name in the attestation text", () => {
    expect(buildVoiceConsentStatement("My Voice")).toContain("My Voice");
  });
});

describe("validateConsentEvidence", () => {
  it("accepts a fully populated consent record", () => {
    expect(validateConsentEvidence(validConsent)).toEqual({ ok: true });
  });
  it("rejects when attestedByUserId/attestedAt is missing", () => {
    expect(validateConsentEvidence({ ...validConsent, attestedByUserId: "" })).toEqual({ ok: false, reason: "missing_attestation" });
    expect(validateConsentEvidence({ ...validConsent, attestedAt: "" })).toEqual({ ok: false, reason: "missing_attestation" });
  });
  it("rejects when statement text/version is missing", () => {
    expect(validateConsentEvidence({ ...validConsent, statementText: "" })).toEqual({ ok: false, reason: "missing_statement" });
    expect(validateConsentEvidence({ ...validConsent, statementVersion: "" })).toEqual({ ok: false, reason: "missing_statement" });
  });
  it("rejects when there are no sample checksums", () => {
    expect(validateConsentEvidence({ ...validConsent, sampleChecksums: [] })).toEqual({ ok: false, reason: "missing_samples" });
  });
  it("rejects null/undefined consent", () => {
    expect(validateConsentEvidence(null)).toEqual({ ok: false, reason: "missing_attestation" });
    expect(validateConsentEvidence(undefined)).toEqual({ ok: false, reason: "missing_attestation" });
  });
});

describe("assertConsentEvidence", () => {
  it("does not throw for valid consent", () => { expect(() => assertConsentEvidence(validConsent)).not.toThrow(); });
  it("throws a reason-coded error for invalid consent", () => {
    expect(() => assertConsentEvidence({ ...validConsent, sampleChecksums: [] })).toThrow("voice_clone_consent_missing_samples");
  });
});
