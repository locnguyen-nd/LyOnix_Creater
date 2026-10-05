import { ArgumentsHost, HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { normalizedError } from "./envelopes.js";
import { HttpErrorEnvelopeFilter } from "./http-exception.filter.js";

const run = (exception: unknown, requestId = "filter-request-id") => {
  let statusCode: number | undefined;
  let body: unknown;
  const headers = new Map<string, string>();
  const response = {
    locals: { requestId },
    setHeader: (name: string, value: string) => headers.set(name, value),
    status: (status: number) => { statusCode = status; return response; },
    json: (value: unknown) => { body = value; return response; },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ header: () => undefined }),
    }),
  } as unknown as ArgumentsHost;
  new HttpErrorEnvelopeFilter().catch(exception, host);
  return { statusCode, body, headers };
};

describe("HTTP error envelope filter", () => {
  it("normalizes framework 404 errors and preserves the request ID", () => {
    const result = run(new HttpException({ message: "Cannot GET /missing" }, HttpStatus.NOT_FOUND));
    expect(result.statusCode).toBe(404);
    expect(result.headers.get("x-request-id")).toBe("filter-request-id");
    expect(result.body).toEqual({
      error: { code: "NOT_FOUND", message: "Cannot GET /missing", details: [], retryable: false },
      meta: { requestId: "filter-request-id" },
    });
  });

  it("does not alter an already-normalized domain error", () => {
    const result = run(normalizedError("FORBIDDEN", "Không có quyền", "domain-request-id", 403));
    expect(result.statusCode).toBe(403);
    expect(result.body).toEqual({
      error: { code: "FORBIDDEN", message: "Không có quyền", details: [], retryable: false },
      meta: { requestId: "domain-request-id" },
    });
  });
});
