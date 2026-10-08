import { describe, expect, it } from "vitest";
import { locales } from "../i18n/locales";
import { cookiesExpiryNote } from "./provider-cookies";

describe("cookies account card (VE2E-145)", () => {
  const now = new Date("2026-10-08T00:00:00Z");

  it("warns when the cookies expire within 3 days", () => {
    expect(cookiesExpiryNote("2026-10-09T00:00:00Z", now)).toMatchObject({ key: "providers.cookiesExpiringSoon", soon: true });
    expect(cookiesExpiryNote("2026-12-01T00:00:00Z", now)).toMatchObject({ key: "providers.cookiesExpires", soon: false });
    expect(cookiesExpiryNote(null, now)).toMatchObject({ key: "providers.cookiesSessionOnly", soon: false });
  });

  it("has every cookies string in vi/en/ja/ko, translated, with the same placeholders", () => {
    const keys = ["cookiesPlatform", "cookiesFile", "cookiesHint", "cookiesExpires", "cookiesExpiringSoon", "cookiesSessionOnly"] as const;
    for (const key of keys) {
      const values = (["vi", "en", "ja", "ko"] as const).map((l) => (locales[l].providers as unknown as Record<string, string>)[key]);
      expect(values.every(Boolean), key).toBe(true);
      expect(new Set(values).size, `${key} translated`).toBe(4);
      expect(new Set(values.map((v) => (v!.match(/{{\w+}}/g) ?? []).join())).size, `${key} placeholders`).toBe(1);
    }
  });
});
