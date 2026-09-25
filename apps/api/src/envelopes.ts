import type { ErrorCode, ErrorDetail, ErrorEnvelope, RequestMeta, Success } from "@lyonix/contracts";
import { HttpException, HttpStatus } from "@nestjs/common";

export const success = <T>(data: T, requestId: string): Success<T> => ({
  data,
  meta: { requestId },
});

export const normalizedError = (
  code: ErrorCode,
  message: string,
  requestId: string,
  status = HttpStatus.BAD_REQUEST,
  details: ErrorDetail[] = [],
  retryable = false,
): HttpException => {
  const body: ErrorEnvelope = {
    error: { code, message, details, retryable },
    meta: { requestId } satisfies RequestMeta,
  };
  return new HttpException(body, status);
};
