import { describe, expect, it } from "vitest";
import type { ApiProvider } from "../jobs-api";
import { mediaAccountsOf } from "./form-state";

const acc = (id: string, provider: string, extra: Partial<ApiProvider> = {}) => ({ id, provider, role: "visual", status: "verified", isFake: false, ...extra }) as ApiProvider;

describe("mediaAccountsOf", () => {
  it("offers any verified, switched-on media source (Pexels or Apify), not just Pexels", () => {
    const list = mediaAccountsOf([acc("px", "pexels"), acc("ap", "apify"), acc("yt", "youtube")]);
    expect(list.map((a) => a.id)).toEqual(["px", "ap"]);
  });
  it("hides accounts that are switched off or unverified", () => {
    const list = mediaAccountsOf([acc("px", "pexels", { enabled: false }), acc("ap", "apify", { status: "unverified" }), acc("ap2", "apify", { enabled: true })]);
    expect(list.map((a) => a.id)).toEqual(["ap2"]);
  });
});
