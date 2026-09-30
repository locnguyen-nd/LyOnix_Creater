import { describe, expect, it } from "vitest";
import { locales } from "./locales";

const KEYS = ["apifyUsageTitle", "apifyUsageLine", "apifyUsageReuse", "apifyUsageUsdUnknown", "apifyQualityLine", "sourceReason_apify_phase2_failed"] as const;

describe("VE2E-51 Apify usage/quality i18n", () => {
  it("has every label in vi/en/ja/ko with the interpolation placeholders", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const pro = locales[locale].studioPro as Record<string, string>;
      for (const key of KEYS) expect(pro[key], `${locale}.${key}`).toBeTruthy();
      expect(pro.apifyUsageLine).toContain("{{runs}}");
      expect(pro.apifyUsageLine).toContain("{{usd}}");
      expect(pro.apifyQualityLine).toContain("{{reasons}}");
    }
  });

  it("ja/ko are translated, not the English fallback", () => {
    for (const locale of ["ja", "ko"] as const) {
      const pro = locales[locale].studioPro as Record<string, string>;
      const en = locales.en.studioPro as Record<string, string>;
      for (const key of KEYS) expect(pro[key]).not.toBe(en[key]);
    }
  });
});
