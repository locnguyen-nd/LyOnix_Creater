import { describe, expect, it } from "vitest";
import { locales } from "./locales";

describe("VE2E-47 template TTS warning translations", () => {
  it("is present in vi/en/ja/ko and interpolates the element names", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      expect(locales[locale].studioPro.templateTtsWarning).toContain("{{names}}");
    }
  });
});
