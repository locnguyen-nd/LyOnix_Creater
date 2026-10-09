import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { voiceCloneBodyParser } from "./voice-clone-body.js";

const PATH = "/api/v1/provider-accounts/acc-1/elevenlabs/voice-clones";

const fakeRequest = (over: { method?: string; path?: string; type?: string | undefined; length?: number } = {}) => {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  emitter.method = over.method ?? "POST";
  emitter.path = over.path ?? PATH;
  emitter.headers = { ...("type" in over ? (over.type === undefined ? {} : { "content-type": over.type }) : { "content-type": "application/json" }), ...(over.length !== undefined ? { "content-length": String(over.length) } : {}) };
  emitter.destroy = vi.fn();
  return emitter as unknown as Request & EventEmitter & { body?: unknown; _body?: boolean };
};

const fakeResponse = () => {
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  emitter.locals = { requestId: "req-1" };
  emitter.status = vi.fn(() => emitter);
  emitter.setHeader = vi.fn(() => emitter);
  emitter.json = vi.fn(() => { emitter.emit("finish"); return emitter; });
  return emitter as unknown as Response & EventEmitter & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};

const send = (request: EventEmitter, ...chunks: string[]) => { for (const chunk of chunks) request.emit("data", Buffer.from(chunk)); request.emit("end"); };

describe("voiceCloneBodyParser", () => {
  it("parses the JSON body of the clone route and marks it parsed for Nest's own parser", () => {
    const request = fakeRequest();
    const next = vi.fn() as unknown as NextFunction;
    voiceCloneBodyParser(1024)(request, fakeResponse(), next);
    send(request, '{"name":"A",', '"files":[]}');
    expect(request.body).toEqual({ name: "A", files: [] });
    expect(request._body).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves every other route, method and content type to the default parser", () => {
    for (const request of [fakeRequest({ path: "/api/v1/jobs" }), fakeRequest({ method: "GET" }), fakeRequest({ type: "text/plain" }), fakeRequest({ type: undefined }), fakeRequest({ path: `${PATH}/extra` })]) {
      const next = vi.fn() as unknown as NextFunction;
      voiceCloneBodyParser(1024)(request, fakeResponse(), next);
      expect(next).toHaveBeenCalledOnce();
      expect(request.listenerCount("data")).toBe(0);
    }
  });

  it("answers 413 from the declared Content-Length without reading the body", () => {
    const response = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;
    voiceCloneBodyParser(1024)(fakeRequest({ length: 2048 }), response, next);
    expect(response.status).toHaveBeenCalledWith(413);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 413 when a chunked body grows past the limit, and drops the connection", () => {
    const request = fakeRequest();
    const response = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;
    voiceCloneBodyParser(8)(request, response, next);
    send(request, "123456", "7890");
    expect(response.status).toHaveBeenCalledWith(413);
    expect(next).not.toHaveBeenCalled();
    expect(request.destroy).toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", () => {
    const request = fakeRequest();
    const response = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;
    voiceCloneBodyParser(1024)(request, response, next);
    send(request, "{nope");
    expect(response.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
