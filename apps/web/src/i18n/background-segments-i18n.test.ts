import { describe, expect, it } from "vitest";
import { locales } from "./locales";

// VE2E-40: the intake "background segments" control is labelled in every UI locale
// (vi default, en/ja/ko) - ja/ko must not silently fall back to the English strings.
const KEYS = ["backgroundSegments", "backgroundSegmentsAuto", "backgroundSegmentsFixed", "backgroundSegmentsHint"] as const;

describe("VE2E-40 background segment i18n", () => {
  it("has every key in vi/en/ja/ko with the interpolation placeholders the page passes", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const jobs = locales[locale].jobs;
      for (const key of KEYS) expect(jobs[key], `${locale}.${key}`).toBeTruthy();
      expect(jobs.backgroundSegmentsAuto).toContain("{{min}}");
      expect(jobs.backgroundSegmentsAuto).toContain("{{max}}");
      expect(jobs.backgroundSegmentsFixed).toContain("{{count}}");
    }
  });

  it("ja/ko are translated, not the English fallback", () => {
    for (const locale of ["ja", "ko"] as const) {
      for (const key of KEYS) expect(locales[locale].jobs[key]).not.toBe(locales.en.jobs[key]);
    }
  });
});

describe("VE2E-41 fix-round studioPro keys", () => {
  it("has scope + shortfall labels in every locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const pro = locales[locale].studioPro;
      for (const key of ["mediaScope", "mediaScopeScene", "mediaScopeSegment", "inPointShortfall"] as const) expect(pro[key], `${locale}.${key}`).toBeTruthy();
      expect(pro.inPointShortfall).toContain("{{seconds}}");
    }
  });
});
