import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ role: "admin" as "admin" | "staff" }));
vi.mock("./auth.helpers.js", () => ({
  requireUser: async () => ({ user: { id: "u1", role: session.role }, session: { csrfToken: "t" } }),
  requireCsrf: vi.fn(),
  requestId: () => "req-1",
}));

import { RenderEngineAdminController } from "./render-engine-admin.controller.js";

describe("RenderEngineAdminController (VE2E-118)", () => {
  const service = { overview: vi.fn(async () => ({ templates: [], metrics: {} })), updateTemplate: vi.fn() };
  const controller = new RenderEngineAdminController({} as never, service as never);
  const request = {} as never;
  const response = { setHeader: vi.fn() } as never;
  beforeEach(() => {
    session.role = "admin";
    service.overview.mockClear();
    service.updateTemplate.mockReset();
  });

  it("is admin-only for both reading metrics and changing rollout", async () => {
    session.role = "staff";
    await expect(controller.overview(undefined, request, response)).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
    await expect(controller.updateTemplate("s1", { rolloutPercent: 50 }, request, response)).rejects.toMatchObject({ response: { error: { code: "FORBIDDEN" } } });
    expect(service.overview).not.toHaveBeenCalled();
    expect(service.updateTemplate).not.toHaveBeenCalled();
  });

  it("passes the window and the actor through, and turns a service refusal into a 400 envelope", async () => {
    await controller.overview("30", request, response);
    expect(service.overview).toHaveBeenCalledWith(30);
    service.updateTemplate.mockResolvedValueOnce({ ok: false, code: "VALIDATION_FAILED", message: "no fallback", status: 400 });
    await expect(controller.updateTemplate("s1", { rolloutPercent: 50 }, request, response)).rejects.toMatchObject({ response: { error: { code: "VALIDATION_FAILED" } } });
    expect(service.updateTemplate).toHaveBeenCalledWith("s1", { rolloutPercent: 50 }, "u1");
  });
});
