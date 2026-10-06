import { afterEach, describe, expect, it } from "vitest";
import { pexelsDisabledOutcome, pexelsSourcingEnabled } from "./pexels-config.js";
import { PexelsService } from "./pexels.service.js";

describe("PEXELS_SOURCING_ENABLED", () => {
  afterEach(() => { delete process.env.PEXELS_SOURCING_ENABLED; });

  it("is on by default and for unrelated values", () => {
    expect(pexelsSourcingEnabled()).toBe(true);
    process.env.PEXELS_SOURCING_ENABLED = "1";
    expect(pexelsSourcingEnabled()).toBe(true);
    process.env.PEXELS_SOURCING_ENABLED = "";
    expect(pexelsSourcingEnabled()).toBe(true);
  });

  it.each(["0", "false", "OFF", " no "])("is off for %j", (value) => {
    process.env.PEXELS_SOURCING_ENABLED = value;
    expect(pexelsSourcingEnabled()).toBe(false);
  });

  it("refuses search, import and auto-import before touching the DB or provider", async () => {
    process.env.PEXELS_SOURCING_ENABLED = "off";
    const service = new PexelsService(null as never, null as never, null as never, null as never);
    const expected = pexelsDisabledOutcome();
    expect(await service.search("p", "u", "admin", { providerAccountId: "a", type: "video", query: "q" })).toEqual(expected);
    expect(await service.import("p", "u", "admin", { providerAccountId: "a", type: "video", externalId: "1" })).toEqual(expected);
    expect(await service.autoImportForScene("p", "u", "admin", { providerAccountId: "a", sceneId: "s", query: "q" } as never)).toEqual(expected);
    expect(expected).toMatchObject({ ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", status: 403 });
  });
});
