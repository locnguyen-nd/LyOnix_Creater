import { describe, expect, it } from "vitest";
import { locales } from "./locales";

const KEYS = [
  "draftSave", "draftSaving", "draftPending", "draftSavedAt", "draftSaveFailed", "draftRetry", "draftConflict", "draftOverwrite",
  "draftDiscard", "draftDiscardTitle", "draftDiscardMessage", "draftDiscardLosesContent", "draftDiscardLosesChoices", "draftDiscardKeepsDefaults", "draftDiscardConfirmButton", "draftDiscarding", "draftRestored", "restoreInvalid", "defaultsTitle", "defaultsHint", "defaultsSave",
  "defaultsSaved", "defaultsReset", "defaultsResetConfirm", "defaultsResetDone", "autoVoiceAccount", "autoMediaAccount", "selectPlaceholder",
] as const;

describe("VE2E-124 draft + defaults translations", () => {
  it("has every key in vi/en/ja/ko with the same placeholders, translated (not English) in vi/ja/ko", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].jobs as unknown as Record<string, string>;
      for (const key of KEYS) {
        expect(strings[key], `${locale}.jobs.${key}`).toBeTruthy();
        const vi = (locales.vi.jobs as unknown as Record<string, string>)[key]!;
        expect([...(strings[key]!.match(/{{\w+}}/g) ?? [])].sort(), `${locale}.jobs.${key}`).toEqual([...(vi.match(/{{\w+}}/g) ?? [])].sort());
        if (locale !== "en") expect(strings[key], `${locale}.jobs.${key} is still English`).not.toBe((locales.en.jobs as unknown as Record<string, string>)[key]);
      }
    }
  });

  it("uses the wording the owner asked for", () => {
    expect(locales.vi.jobs.draftSave).toBe("Lưu bản nháp");
    expect(locales.vi.jobs.draftSavedAt).toBe("Đã lưu lúc {{time}}");
    expect(locales.vi.jobs.draftSaving).toBe("Đang lưu…");
    expect(locales.vi.jobs.draftSaveFailed).toBe("Không thể lưu bản nháp");
    expect(locales.vi.jobs.defaultsSave).toBe("Lưu các lựa chọn này làm mặc định");
    expect(locales.vi.jobs.defaultsSaved).toBe("Đã lưu làm tùy chọn mặc định");
    expect(locales.vi.jobs.defaultsReset).toBe("Đặt lại mặc định");
  });
});
