import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireCsrf: vi.fn() }));
vi.mock("./auth.helpers.js", () => ({
  requireUser: async () => ({ user: { id: "u1", role: "staff" }, session: { csrfToken: "t" } }),
  requireCsrf: auth.requireCsrf,
  requestId: () => "req-1",
}));

import { SubtitleVersionsController } from "./subtitle-versions.controller.js";

describe("SubtitleVersionsController (V03-03)", () => {
  const service = { list: vi.fn(), saveEdit: vi.fn(), resetToAuto: vi.fn() };
  const controller = new SubtitleVersionsController({} as never, service as never);
  const request = {} as never;
  const response = {} as never;

  beforeEach(() => {
    auth.requireCsrf.mockReset();
    service.list.mockReset();
    service.saveEdit.mockReset();
    service.resetToAuto.mockReset();
  });

  it("checks CSRF on both writes and passes the body through to the service", async () => {
    service.saveEdit.mockResolvedValueOnce({ ok: true, data: { id: "sub-2" } });
    service.resetToAuto.mockResolvedValueOnce({ ok: true, data: { id: "sub-3" } });
    const cues = [{ text: "a", startMs: 0, endMs: 500 }];
    await expect(controller.save("audio-1", { basedOnSubtitleVersionId: "sub-1", cues }, request, response)).resolves.toMatchObject({ data: { id: "sub-2" }, meta: { requestId: "req-1" } });
    await controller.reset("audio-1", { basedOnSubtitleVersionId: "sub-2" }, request, response);
    expect(auth.requireCsrf).toHaveBeenCalledTimes(2);
    expect(service.saveEdit).toHaveBeenCalledWith("audio-1", "u1", "staff", { basedOnSubtitleVersionId: "sub-1", cues });
    expect(service.resetToAuto).toHaveBeenCalledWith("audio-1", "u1", "staff", { basedOnSubtitleVersionId: "sub-2" });
  });

  it("turns a refusal into an error envelope with its status and per-cue details", async () => {
    service.saveEdit.mockResolvedValueOnce({ ok: false, code: "VALIDATION_FAILED", message: "Dòng 1: ...", status: 400, details: [{ field: "cues[0]", code: "TEXT_EMPTY" }] });
    await expect(controller.save("audio-1", { basedOnSubtitleVersionId: "sub-1", cues: [] }, request, response)).rejects.toMatchObject({
      status: 400,
      response: { error: { code: "VALIDATION_FAILED", details: [{ field: "cues[0]", code: "TEXT_EMPTY" }] } },
    });
    service.list.mockResolvedValueOnce({ ok: false, code: "VERSION_CONFLICT", message: "x", status: 409 });
    await expect(controller.list("audio-1", request, response)).rejects.toMatchObject({ status: 409 });
  });
});
