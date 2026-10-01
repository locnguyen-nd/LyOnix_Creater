import { describe, expect, it } from "vitest";
import { locales } from "./locales";

describe("VE2E-60 full preview translations", () => {
  it("has every full-preview key in vi/en/ja/ko with the same placeholders", () => {
    const keys = Object.keys(locales.vi.studioPro).filter((key) => key.startsWith("fullPreview"));
    expect(keys.length).toBeGreaterThanOrEqual(17);
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro as Record<string, string>;
      for (const key of keys) {
        expect(strings[key], `${locale}.${key}`).toBeTruthy();
        const vi = (locales.vi.studioPro as Record<string, string>)[key]!;
        expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort()).toEqual([...(vi.match(/{{\w+}}/g) ?? [])].sort());
      }
    }
  });
});
