import type { MediaJobErrorCode } from "@lyonix/media-jobs";

export class MediaJobError extends Error {
  constructor(readonly code: MediaJobErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = "MediaJobError";
  }
}

/** Another delivery/process holds the job lock; consumer should requeue with a delay. */
export class JobLockBusyError extends Error {
  constructor(readonly jobKey: string) {
    super(`media job ${jobKey} is being processed elsewhere`);
    this.name = "JobLockBusyError";
  }
}
