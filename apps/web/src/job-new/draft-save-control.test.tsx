import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { DraftSaveStatus } from "./draft-autosave";

const { DraftSaveControl, draftSaveMode, earnsSaveFlash } = await import("./DraftSaveControl");
const { locales } = await import("../i18n/locales");

type Lng = "vi" | "en" | "ja" | "ko";
const render = async (status: DraftSaveStatus, lng: Lng = "vi", disabled = false) => {
  const instance = i18n.createInstance();
  await instance.init({ lng, resources: { [lng]: { translation: locales[lng] } }, interpolation: { escapeValue: false } });
  return renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <DraftSaveControl status={status} disabled={disabled} onSave={() => undefined} onRetry={() => undefined} onOverwrite={() => undefined} formatTime={() => "14:33"} />
    </I18nextProvider>,
  );
};
const button = (html: string) => /<button[^>]*data-testid="draft-save-button"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";

describe("draft save button feedback", () => {
  it("default: a save icon and 'Lưu bản nháp'", async () => {
    const html = await render({ kind: "idle" });
    expect(html).toMatch(/data-testid="draft-save" data-mode="idle"/);
    expect(button(html)).toContain("lucide-save");
    expect(button(html)).toContain("Lưu bản nháp");
    expect(button(html)).not.toContain("disabled");
  });

  it("saving: spinner, 'Đang lưu…', busy and not clickable twice", async () => {
    const html = await render({ kind: "saving" });
    expect(button(html)).toContain("animate-spin");
    expect(button(html)).toContain("Đang lưu…");
    expect(button(html)).toMatch(/disabled=""/);
    expect(button(html)).toContain('aria-busy="true"');
  });

  it("saved: the time it was stored, with a check (fade in); unsaved changes: a pulsing dot", async () => {
    const saved = await render({ kind: "saved", at: new Date() });
    expect(saved).toMatch(/role="status" class="lyx-anim-fade-up[^"]*"[^>]*data-testid="draft-status"/);
    expect(saved).toContain("Đã lưu lúc 14:33");
    const pending = await render({ kind: "pending" });
    expect(pending).toContain("lyx-anim-soft-pulse");
    expect(pending).toContain("Có thay đổi chưa lưu");
  });

  it("failed: red button that retries, alert message; conflict: alert with overwrite", async () => {
    const failed = await render({ kind: "error", message: "network" });
    expect(failed).toMatch(/data-mode="error"/);
    expect(button(failed)).toContain("text-lyx-danger");
    expect(button(failed)).toContain("Thử lại");
    expect(failed).toMatch(/role="alert"[^>]*>[\s\S]*Không thể lưu bản nháp/);
    const conflict = await render({ kind: "conflict" });
    expect(conflict).toContain("Bản nháp đã được lưu ở tab hoặc máy khác.");
    expect(conflict).toContain(locales.vi.jobs.draftOverwrite);
  });

  it("the green 'Đã lưu' success plays only after a save the user asked for", () => {
    const saved: DraftSaveStatus = { kind: "saved", at: new Date() };
    expect(earnsSaveFlash("saving", saved, true)).toBe(true);
    expect(earnsSaveFlash("saving", saved, false)).toBe(false); // background autosave: no flash
    expect(earnsSaveFlash("saved", saved, true)).toBe(false);
    expect(earnsSaveFlash("saving", { kind: "error", message: "x" }, true)).toBe(false);
    expect(draftSaveMode({ kind: "saved", at: new Date() }, true)).toBe("saved");
    expect(draftSaveMode({ kind: "saved", at: new Date() }, false)).toBe("idle");
    expect(draftSaveMode({ kind: "saving" }, true)).toBe("saving");
    expect(draftSaveMode({ kind: "error", message: "x" }, true)).toBe("error");
  });

  it("is translated (vi / en / ja / ko) including the new 'saved' label", async () => {
    for (const lng of ["vi", "en", "ja", "ko"] as const) {
      expect(locales[lng].jobs.draftSavedNow, lng).toBeTruthy();
      const html = await render({ kind: "saved", at: new Date() }, lng);
      expect(html).not.toMatch(/[>"]jobs\./);
    }
    expect(new Set(["vi", "en", "ja", "ko"].map((lng) => locales[lng as Lng].jobs.draftSavedNow)).size).toBe(4);
  });
});
