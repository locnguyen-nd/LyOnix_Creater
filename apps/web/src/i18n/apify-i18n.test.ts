import { describe, expect, it } from "vitest";
import { locales } from "./locales";

const KEYS = ["apifyTab", "apifyPlatform", "apifyPlatformTiktok", "apifyPlatformPinterest", "apifyPlatformX", "apifyPlatformGoogleImage", "apifyPlatformGoogleVideo", "apifyKeyword", "apifyLangJa", "apifyLangEn", "apifySearch", "apifySearching", "apifyNoAccount", "apifyRiskBadge", "apifyPreviewOnly", "apifyImport", "apifyNoResults", "apifyBackupUsed", "apifyImporting"] as const;

describe("VE2E-34 Studio Apify tab i18n", () => {
  it("has every label in vi/en/ja/ko", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const pro = locales[locale].studioPro as Record<string, string>;
      for (const key of KEYS) expect(pro[key], `${locale}.${key}`).toBeTruthy();
      expect(pro.apifyBackupUsed).toContain("{{actor}}");
    }
  });

  it("ja/ko are translated, not the English fallback", () => {
    for (const locale of ["ja", "ko"] as const) {
      const pro = locales[locale].studioPro as Record<string, string>;
      const en = locales.en.studioPro as Record<string, string>;
      for (const key of ["apifyPlatform", "apifySearch", "apifyRiskBadge", "apifyImport"]) expect(pro[key]).not.toBe(en[key]);
    }
  });
});
