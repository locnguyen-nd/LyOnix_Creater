import type { ComposeErrorCode, ComposeQcReport } from "@lyonix/media-jobs";

/** Failure of one `video.compose` job. Superset of `MediaJobError` codes (adds recipe/font/QC codes); `qc` carries the full report for QC failures. */
export class ComposeJobError extends Error {
  constructor(
    readonly code: ComposeErrorCode,
    message: string,
    readonly retryable = false,
    readonly qc: ComposeQcReport | null = null,
  ) {
    super(message);
    this.name = "ComposeJobError";
  }
}
