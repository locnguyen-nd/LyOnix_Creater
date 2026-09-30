/** VE2E-48: shared by Studio (after Auto-fill) and the Auto run detail page to render a segment's source + fallback reason. */
export type SourceReasonKey =
  | "no_apify_account"
  | "no_ja_keywords"
  | "no_content_account"
  | "extraction_failed"
  | "apify_no_usable_candidate"
  | "apify_duplicate_or_unsupported_source"
  | "platform_not_importable"
  | "apify_error"
  | "apify_abstained"
  | "apify_import_failed";

const known: ReadonlySet<string> = new Set<SourceReasonKey>([
  "no_apify_account",
  "no_ja_keywords",
  "no_content_account",
  "extraction_failed",
  "apify_no_usable_candidate",
  "apify_duplicate_or_unsupported_source",
  "platform_not_importable",
  "apify_error",
  "apify_abstained",
  "apify_import_failed",
]);

/** `apify_error:PROVIDER_TIMEOUT` -> `{ key: "apify_error", detail: "PROVIDER_TIMEOUT" }`; unknown reasons return `key: null` (show raw). */
export const parseSourceReason = (reason: string | null | undefined): { key: SourceReasonKey | null; detail: string; raw: string } | null => {
  if (!reason) return null;
  const [head = "", ...rest] = reason.split(":");
  return { key: known.has(head) ? (head as SourceReasonKey) : null, detail: rest.join(":"), raw: reason };
};
