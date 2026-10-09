/**
 * Voice clone sample limits, shared by the request-body parser (main.ts), the service and the web dialog's copy of the same numbers.
 * Samples travel as base64 inside the JSON body (+33 %), so the body limit leaves room above `maxTotalBytes`.
 */
export const VOICE_CLONE_LIMITS = {
  maxFiles: 5,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxNameLength: 60,
  bodyLimitBytes: 30 * 1024 * 1024,
} as const;
