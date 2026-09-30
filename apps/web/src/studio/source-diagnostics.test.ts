import { describe, expect, it } from "vitest";
import { parseSourceReason } from "./source-diagnostics";
import { locales } from "../i18n/locales";

describe("parseSourceReason (VE2E-48)", () => {
  it("returns null for no reason and splits detail from coded reasons", () => {
    expect(parseSourceReason(null)).toBeNull();
    expect(parseSourceReason("no_apify_account")).toMatchObject({ key: "no_apify_account", detail: "" });
    expect(parseSourceReason("apify_error:PROVIDER_TIMEOUT")).toMatchObject({ key: "apify_error", detail: "PROVIDER_TIMEOUT" });
    expect(parseSourceReason("something_else")).toMatchObject({ key: null, raw: "something_else" });
  });

  it("has a translation for every reason in vi/en/ja/ko", () => {
    for (const lng of ["vi", "en", "ja", "ko"] as const) {
      const studio = (locales[lng].studioPro as Record<string, string>);
      for (const key of ["no_apify_account", "no_ja_keywords", "no_content_account", "extraction_failed", "apify_no_usable_candidate", "apify_error"]) expect(studio[`sourceReason_${key}`], `${lng}.${key}`).toBeTruthy();
      expect(studio.sourceApify && studio.sourcePexels && studio.sourcingTitle).toBeTruthy();
    }
  });
});
