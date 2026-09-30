/**
 * VE2E-47: pure helpers for the "template audio element carries a Creatomate-side TTS provider"
 * problem. A Creatomate audio element with `provider` treats `source` as text to speak and bills the
 * owner's ElevenLabs account itself, next to LyOnix's own ElevenLabs audio. No I/O here.
 */
import type { ErrorCode, TemplateModificationSlotResponse, TemplateSnapshotWarning } from "@lyonix/contracts";
import {
  TTS_PROVIDER_DISABLED_VALUE,
  deriveTemplateModifications,
  findTemplateTtsElements,
  ttsProviderOverrideKey,
} from "@lyonix/providers";

export { TTS_PROVIDER_DISABLED_VALUE, ttsProviderOverrideKey };

/**
 * Slots stored on a snapshot pinned before VE2E-47 have no `ttsProvider`; `rawTemplate` is persisted
 * with every snapshot, so re-derive it from there. Slots already carrying the field are untouched.
 */
export function slotsWithTtsProvider(slots: TemplateModificationSlotResponse[], rawTemplate: unknown): TemplateModificationSlotResponse[] {
  if (!rawTemplate || !slots.some((slot) => slot.kind === "audio" && slot.ttsProvider === undefined)) return slots;
  const providerByKey = new Map(
    deriveTemplateModifications(rawTemplate)
      .filter((slot) => slot.ttsProvider)
      .map((slot) => [slot.key, slot.ttsProvider!] as const),
  );
  if (providerByKey.size === 0) return slots;
  return slots.map((slot) => (slot.kind === "audio" && slot.ttsProvider === undefined && providerByKey.has(slot.key) ? { ...slot, ttsProvider: providerByKey.get(slot.key)! } : slot));
}

export function templateTtsWarnings(rawTemplate: unknown): TemplateSnapshotWarning[] {
  return findTemplateTtsElements(rawTemplate).map((element) => ({
    code: "TEMPLATE_TTS_PROVIDER" as const,
    elementName: element.elementName,
    slotKey: element.dynamic ? `${element.elementName}.source` : null,
    provider: element.provider,
  }));
}

/** Audio slots with a template TTS provider that received no LyOnix audio (`providedKeys`) - Creatomate would synthesize (and bill) them. */
export function unfilledTtsSlotKeys(slots: TemplateModificationSlotResponse[], providedKeys: Iterable<string>): string[] {
  const provided = new Set(providedKeys);
  return slots.filter((slot) => slot.kind === "audio" && slot.ttsProvider && !provided.has(slot.key)).map((slot) => slot.key);
}

export function templateTtsConflictMessage(keys: string[]): string {
  return (
    `Template có phần giọng đọc dùng TTS riêng của Creatomate (${keys.join(", ")}) nhưng cảnh tương ứng không có audio của LyOnix; ` +
    "Creatomate sẽ tự tạo và tính phí giọng đọc (ElevenLabs). Hãy gán voice cho các cảnh này, đổi template (xoá provider khỏi Voiceover-N), " +
    "hoặc cho phép TTS của template một cách tường minh (allowTemplateTts)."
  );
}

/**
 * Maps a Creatomate render `error_message` to a specific code instead of the generic
 * PROVIDER_SUBMIT_UNKNOWN. Only messages that clearly name the TTS provider / quota are re-coded.
 */
export function classifyCreatomateRenderError(rawMessage: string | null | undefined): { code: ErrorCode; message: string } {
  const message = rawMessage?.trim() || "Creatomate render failed";
  const mentionsTts = /eleven\s?labs|text[- ]to[- ]speech|\btts\b/i.test(message);
  const mentionsQuota = /quota|credit/i.test(message);
  if (mentionsTts && mentionsQuota) {
    return { code: "PROVIDER_QUOTA_EXHAUSTED", message: `Hết quota ElevenLabs phía Creatomate (TTS của template): ${message}` };
  }
  if (mentionsTts) {
    return { code: "TEMPLATE_TTS_FAILED", message: `Creatomate lỗi khi tự tạo giọng đọc (TTS của template): ${message}` };
  }
  if (mentionsQuota) {
    return { code: "PROVIDER_QUOTA_EXHAUSTED", message: `Creatomate hết quota/credit: ${message}` };
  }
  return { code: "PROVIDER_SUBMIT_UNKNOWN", message };
}
