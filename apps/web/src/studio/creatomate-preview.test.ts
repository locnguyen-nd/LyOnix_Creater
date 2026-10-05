import { describe, expect, it } from "vitest";
import { evaluatePreviewSupport } from "./creatomate-preview";

describe("evaluatePreviewSupport", () => {
  it("supports a desktop-width, non-mobile browser", () => {
    expect(evaluatePreviewSupport("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0", 1440)).toBe(true);
  });

  it("rejects a mobile user agent even at a wide viewport (Creatomate SDK is desktop-only)", () => {
    expect(evaluatePreviewSupport("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Mobile Safari/537.36", 1024)).toBe(false);
  });

  it("rejects an iPad/iPhone user agent", () => {
    expect(evaluatePreviewSupport("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15", 1024)).toBe(false);
  });

  it("rejects a narrow viewport even on a desktop-looking user agent", () => {
    expect(evaluatePreviewSupport("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0", 500)).toBe(false);
  });

  it("treats innerWidth 0 (unknown/unavailable) as not disqualifying", () => {
    expect(evaluatePreviewSupport("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0", 0)).toBe(true);
  });
});
