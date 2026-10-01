import { describe, expect, it } from "vitest";
import { locales } from "./locales";

const placeholders = (value: string) => [...(value.match(/{{\w+}}/g) ?? [])].sort();

describe("VE2E-62 queue translations", () => {
  it("has every queue key in vi/en/ja/ko with matching placeholders (ja/ko inherit videoProductions from en)", () => {
    const viQueue = Object.entries(locales.vi.videoProductions).filter(([key]) => key.startsWith("queue") && key !== "queueKind");
    expect(viQueue.length).toBeGreaterThanOrEqual(7);
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].videoProductions as Record<string, unknown>;
      for (const [key, viValue] of viQueue) {
        expect(strings[key], `${locale}.videoProductions.${key}`).toBeTruthy();
        expect(placeholders(String(strings[key]))).toEqual(placeholders(String(viValue)));
      }
      expect(Object.keys(locales[locale].videoProductions.queueKind).sort()).toEqual(["media", "render", "workflow"]);
    }
  });

  it("has the render queue lines in every studioPro locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro as Record<string, string>;
      for (const key of ["renderQueueMedia", "renderQueueProvider"]) {
        expect(strings[key], `${locale}.studioPro.${key}`).toContain("{{position}}");
      }
    }
  });
});
