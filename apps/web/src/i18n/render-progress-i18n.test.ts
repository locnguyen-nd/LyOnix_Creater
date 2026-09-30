import { describe, expect, it } from "vitest";
import { locales } from "./locales";

describe("VE2E-43 render progress translations", () => {
  it("provides clip count and per-clip error text in every Studio locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro;
      expect(strings.renderPreparing).toBeTruthy();
      expect(strings.renderClipsProgress).toContain("{{ready}}");
      expect(strings.renderClipsProgress).toContain("{{total}}");
      expect(strings.renderClipFailure).toContain("{{scene}}");
      expect(strings.renderClipFailure).toContain("{{code}}");
      expect(strings.renderClipFailure).toContain("{{message}}");
    }
  });

  it("VE2E-52: template layout notes in every locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro;
      expect(strings.layoutFallbackWarning).toBeTruthy();
      expect(strings.rankBadgesRenumbered).toContain("{{count}}");
    }
  });
});
