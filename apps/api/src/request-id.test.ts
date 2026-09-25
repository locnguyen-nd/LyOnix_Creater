import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requestIdMiddleware } from "./request-id.js";

const run = (incoming: string | undefined) => {
  const headers = new Map<string, string>();
  const request = { header: () => incoming } as unknown as Request;
  const response = {
    locals: {} as Record<string, string>,
    setHeader: (name: string, value: string) => { headers.set(name, value); },
  } as unknown as Response;
  let nextCalls = 0;
  requestIdMiddleware(request, response, (() => { nextCalls += 1; }) as NextFunction);
  return { headers, locals: response.locals, nextCalls };
};

describe("request ID middleware", () => {
  it("propagates an incoming X-Request-Id to the response and context", () => {
    const result = run("caller-request-123");
    expect(result.headers.get("x-request-id")).toBe("caller-request-123");
    expect(result.locals.requestId).toBe("caller-request-123");
    expect(result.nextCalls).toBe(1);
  });

  it("generates a UUID when no request ID is supplied", () => {
    const first = run(undefined);
    const second = run(undefined);
    expect(first.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first.locals.requestId).toBe(first.headers.get("x-request-id"));
    expect(second.locals.requestId).not.toBe(first.locals.requestId);
    expect(first.nextCalls).toBe(1);
  });
});
