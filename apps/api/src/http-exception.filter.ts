import { ArgumentsHost, Catch, HttpException, HttpStatus, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { ErrorCode, ErrorEnvelope } from "@lyonix/contracts";

const errorCodesByStatus: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: "VALIDATION_FAILED",
  [HttpStatus.UNAUTHORIZED]: "UNAUTHENTICATED",
  [HttpStatus.FORBIDDEN]: "FORBIDDEN",
  [HttpStatus.NOT_FOUND]: "NOT_FOUND",
  [HttpStatus.CONFLICT]: "INVALID_STATE",
  [HttpStatus.PRECONDITION_FAILED]: "VERSION_CONFLICT",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "UPLOAD_LIMIT_EXCEEDED",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "UNSUPPORTED_MEDIA",
  [HttpStatus.BAD_GATEWAY]: "PROVIDER_UNAVAILABLE",
  [HttpStatus.SERVICE_UNAVAILABLE]: "PROVIDER_UNAVAILABLE",
};

const isErrorEnvelope = (value: unknown): value is ErrorEnvelope => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ErrorEnvelope>;
  return Boolean(candidate.error && candidate.meta && typeof candidate.meta.requestId === "string");
};

const messageOf = (value: unknown, fallback: string) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
    return (value as { message: string }).message;
  }
  return fallback;
};

@Catch()
export class HttpErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const requestId = response.locals.requestId ?? request.header("x-request-id") ?? randomUUID();
    response.setHeader("x-request-id", requestId);

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : undefined;
    const body: ErrorEnvelope = isErrorEnvelope(exceptionResponse)
      ? exceptionResponse
      : {
          error: {
            code: errorCodesByStatus[status] ?? "PROVIDER_UNAVAILABLE",
            message: messageOf(exceptionResponse, status >= 500 ? "Lỗi hệ thống" : "Yêu cầu không hợp lệ"),
            details: [],
            retryable: status >= 500,
          },
          meta: { requestId },
        };

    response.status(status).json(body);
  }
}
