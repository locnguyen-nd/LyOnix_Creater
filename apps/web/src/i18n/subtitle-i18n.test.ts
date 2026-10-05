import { describe, expect, it } from "vitest";
import { locales } from "./locales";

describe("V03-03 subtitle editor translations", () => {
  it("has every subtitle key in vi/en/ja/ko with the same placeholders", () => {
    const keys = Object.keys(locales.vi.studioPro).filter((key) => key.startsWith("subtitle"));
    expect(keys.length).toBeGreaterThanOrEqual(33);
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro as Record<string, string>;
      for (const key of keys) {
        expect(strings[key], `${locale}.${key}`).toBeTruthy();
        const vi = (locales.vi.studioPro as Record<string, string>)[key]!;
        expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${locale}.${key}`).toEqual([...(vi.match(/{{\w+}}/g) ?? [])].sort());
      }
    }
  });
});
