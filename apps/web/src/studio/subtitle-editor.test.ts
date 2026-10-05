import { describe, expect, it } from "vitest";
import { locales } from "../i18n/locales";
import { cueErrorKey, cuesChanged, errorsByCue, formatCueTime } from "./subtitle-editor";

describe("subtitle editor helpers (V03-03)", () => {
  it("formats cue times in seconds with two decimals", () => {
    expect(formatCueTime(1234)).toBe("1.23");
    expect(formatCueTime(0)).toBe("0.00");
    expect(formatCueTime(-5)).toBe("0.00");
  });

  it("keeps the first error per cue and maps every code to an existing string", () => {
    const map = errorsByCue([{ index: 1, code: "OVERLAP" }, { index: 1, code: "TEXT_EMPTY" }, { index: -1, code: "NO_CUES" }]);
    expect(map.get(1)).toBe("OVERLAP");
    expect(map.get(-1)).toBe("NO_CUES");
    const studioPro = locales.vi.studioPro as Record<string, string>;
    for (const code of ["NO_CUES", "TOO_MANY_CUES", "NOT_INTEGER", "TEXT_EMPTY", "TEXT_TOO_LONG", "OUT_OF_RANGE", "TOO_SHORT", "OVERLAP"] as const) {
      expect(studioPro[cueErrorKey(code).replace("studioPro.", "")], code).toBeTruthy();
    }
  });

  it("treats whitespace-only text changes as no change, but any timing or line count change as a change", () => {
    const saved = [{ text: "Xin chào", startMs: 0, endMs: 900 }];
    expect(cuesChanged([{ text: " Xin  chào ", startMs: 0, endMs: 900 }], saved)).toBe(false);
    expect(cuesChanged([{ text: "Xin chào", startMs: 0, endMs: 1000 }], saved)).toBe(true);
    expect(cuesChanged([{ text: "Chào", startMs: 0, endMs: 900 }], saved)).toBe(true);
    expect(cuesChanged([], saved)).toBe(true);
  });
});
