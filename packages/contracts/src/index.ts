export const API_PREFIX = "/api/v1" as const;

export const roles = ["admin", "staff"] as const;
export type Role = (typeof roles)[number];

export const locales = ["vi", "en", "ja", "ko"] as const;
export type UiLocale = (typeof locales)[number];

export const operationStatuses = [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "needs_attention",
] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export type RequestMeta = { requestId: string };
export type Success<T> = { data: T; meta: RequestMeta };
export type Page = { nextCursor: string | null; hasMore: boolean };
export type ListSuccess<T> = { data: T[]; page: Page; meta: RequestMeta };
export type ErrorDetail = { field?: string; code: string };

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_STATE"
  | "DUPLICATE_TOPIC_REQUIRES_OVERRIDE"
  | "PROVIDER_AUTH_INVALID"
  | "PROVIDER_CAPABILITY_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "PROVIDER_SCHEMA_INVALID"
  | "PROVIDER_CONTENT_REFUSED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_SUBMIT_UNKNOWN"
  | "PROVIDER_UNAVAILABLE"
  | "UPLOAD_LIMIT_EXCEEDED"
  | "UNSUPPORTED_MEDIA"
  | "SSRF_BLOCKED"
  | "REVENUE_UNAVAILABLE"
  | "WEBHOOK_INVALID";

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    details: ErrorDetail[];
    retryable: boolean;
  };
  meta: RequestMeta;
};

export type AsyncOperation = {
  operationId: string;
  resourceType: string;
  resourceId: string;
  status: OperationStatus;
  pollUrl: `${typeof API_PREFIX}/operations/${string}`;
};
