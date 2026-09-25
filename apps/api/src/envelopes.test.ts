import { describe, expect, it } from "vitest";
import { normalizedError, success } from "./envelopes.js";

describe("API envelopes", () => {
  it("includes request IDs in successful responses", () => {
    expect(success({ ok: true }, "request-1")).toEqual({
      data: { ok: true },
      meta: { requestId: "request-1" },
    });
  });

  it("normalizes errors without exposing stack traces", () => {
    const exception = normalizedError("NOT_FOUND", "Không tìm thấy", "request-2", 404);
    expect(exception.getResponse()).toEqual({
      error: { code: "NOT_FOUND", message: "Không tìm thấy", details: [], retryable: false },
      meta: { requestId: "request-2" },
    });
  });
});
