import { describe, expect, it } from "vitest";
import { locales } from "./locales";
import { isOutputBelowCanvas } from "../components/RenderProgress";

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

  it("VE2E-52b: output resolution + below-canvas warning in every locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro;
      expect(strings.renderOutputResolution).toContain("{{width}}");
      expect(strings.renderOutputBelowCanvas).toContain("{{canvasWidth}}");
    }
  });

  it("VE2E-52b: isOutputBelowCanvas warns at 270x480 vs 1080x1920, not for full size or old jobs", () => {
    expect(isOutputBelowCanvas({ outputWidth: 270, outputHeight: 480, canvasWidth: 1080, canvasHeight: 1920 })).toBe(true);
    expect(isOutputBelowCanvas({ outputWidth: 1080, outputHeight: 1920, canvasWidth: 1080, canvasHeight: 1920 })).toBe(false);
    expect(isOutputBelowCanvas({})).toBe(false);
  });
  it("VE2E-52: template layout notes in every locale", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].studioPro;
      expect(strings.layoutFallbackWarning).toBeTruthy();
      expect(strings.rankBadgesRenumbered).toContain("{{count}}");
    }
  });
});
