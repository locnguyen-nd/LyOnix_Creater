import { describe, expect, it, vi } from "vitest";
import { MediaPlanService } from "./media-plan.service.js";

const build = (selected: { provider: string; enabled: boolean } | null, apifyAccount: object | null) => {
  const prisma = { providerAccount: { findFirst: vi.fn(async () => selected) } };
  const apify = { findAccountForUser: vi.fn(async () => apifyAccount) };
  return new MediaPlanService(prisma as never, {} as never, {} as never, apify as never);
};

describe("MediaPlanService.checkMediaSourcesEnabled (provider on/off switch)", () => {
  it("passes when the chosen Pexels account is on", async () => {
    expect(await build({ provider: "pexels", enabled: true }, null).checkMediaSourcesEnabled("u", "staff", "a")).toEqual({ ok: true });
  });
  it("passes when Pexels is off but an Apify account is on", async () => {
    expect(await build({ provider: "pexels", enabled: false }, { id: "x" }).checkMediaSourcesEnabled("u", "staff", "a")).toEqual({ ok: true });
  });
  it("fails early with a clear code when Pexels and Apify are both off", async () => {
    const result = await build({ provider: "pexels", enabled: false }, null).checkMediaSourcesEnabled("u", "staff", "a");
    expect(result).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE" });
  });
});
