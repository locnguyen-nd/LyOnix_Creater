import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireCsrf: vi.fn(), userId: "user-a" }));
vi.mock("./auth.helpers.js", () => ({
  requireUser: async () => ({ user: { id: auth.userId, role: "staff" }, session: { csrfToken: "t" } }),
  requireCsrf: auth.requireCsrf,
  requestId: () => "req-1",
}));

import { MeCreationController } from "./me-creation.controller.js";

describe("MeCreationController (VE2E-124)", () => {
  const drafts = { get: vi.fn(), save: vi.fn(), remove: vi.fn() };
  const preferences = { get: vi.fn(), save: vi.fn(), reset: vi.fn() };
  const controller = new MeCreationController({} as never, drafts as never, preferences as never);
  const request = {} as never;
  const response = {} as never;

  beforeEach(() => {
    auth.requireCsrf.mockReset();
    auth.userId = "user-a";
    for (const mock of [...Object.values(drafts), ...Object.values(preferences)]) mock.mockReset();
  });

  it("always acts as the signed-in user - a userId in the body is ignored", async () => {
    drafts.save.mockResolvedValueOnce({ ok: true, data: { version: 1 } });
    await controller.saveDraft("job_new", { payload: { topic: "x" }, baseVersion: null, userId: "user-b" } as never, request, response);
    expect(drafts.save).toHaveBeenCalledWith("user-a", "job_new", { payload: { topic: "x" }, baseVersion: null });
    preferences.save.mockResolvedValueOnce({ ok: true, data: { version: 1 } });
    await controller.savePreferences({ options: { language: "ja" }, userId: "user-b" } as never, request, response);
    expect(preferences.save).toHaveBeenCalledWith("user-a", "staff", { options: { language: "ja" } });
  });

  it("checks CSRF on every write, not on reads", async () => {
    drafts.get.mockResolvedValue({ ok: true, data: null });
    preferences.get.mockResolvedValue({ ok: true, data: null });
    drafts.save.mockResolvedValue({ ok: true, data: {} });
    drafts.remove.mockResolvedValue({ ok: true, data: { deleted: true } });
    preferences.save.mockResolvedValue({ ok: true, data: {} });
    preferences.reset.mockResolvedValue({ ok: true, data: { reset: true } });
    await controller.getDraft("job_new", request, response);
    await controller.getPreferences(request, response);
    expect(auth.requireCsrf).not.toHaveBeenCalled();
    await controller.saveDraft("job_new", { payload: {}, baseVersion: null }, request, response);
    await controller.deleteDraft("job_new", request, response);
    await controller.savePreferences({ options: {} }, request, response);
    await controller.resetPreferences(request, response);
    expect(auth.requireCsrf).toHaveBeenCalledTimes(4);
  });

  it("maps a refusal to an error envelope with its status", async () => {
    drafts.save.mockResolvedValueOnce({ ok: false, code: "VERSION_CONFLICT", message: "x", status: 409 });
    await expect(controller.saveDraft("job_new", { payload: {}, baseVersion: 3 }, request, response)).rejects.toMatchObject({ status: 409, response: { error: { code: "VERSION_CONFLICT" } } });
  });
});
