import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ api: vi.fn(), saveDraft: vi.fn(), savePreferences: vi.fn() }));
vi.mock("../api", () => ({ api: calls.api, csrfHeaders: vi.fn(async () => ({})), ApiError: class extends Error { code = ""; } }));
vi.mock("../job-new/creation-api", () => ({
  getJobNewDraft: vi.fn(async () => null),
  saveJobNewDraft: calls.saveDraft,
  deleteJobNewDraft: vi.fn(),
  getCreationPreferences: vi.fn(async () => null),
  saveCreationPreferences: calls.savePreferences,
  resetCreationPreferences: vi.fn(),
}));
vi.mock("../studio/timeline-api", () => ({ listCreatomateTemplates: vi.fn(async () => []), listElevenLabsVoices: vi.fn(async () => []), pinTemplateSnapshot: vi.fn() }));
vi.mock("../video-productions-api", () => ({ setupAutoProfile: vi.fn(), submitVideoProduction: vi.fn() }));

const { JobNewPage } = await import("./JobNewPage");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });

const html = () =>
  renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <MemoryRouter initialEntries={["/jobs/new"]}>
        <JobNewPage />
      </MemoryRouter>
    </I18nextProvider>,
  );

describe("JobNewPage first paint (VE2E-124)", () => {
  it("shows the draft bar and the per-user defaults box", () => {
    const out = html();
    expect(out).toContain('data-testid="draft-bar"');
    expect(out).toContain("Lưu bản nháp");
    expect(out).toContain("Xoá bản nháp");
    expect(out).toContain('data-testid="defaults-box"');
    expect(out).toContain("Lưu các lựa chọn này làm mặc định");
    expect(out).toContain("Đặt lại mặc định");
  });

  it("before the draft/defaults are restored nothing can be saved or submitted, so the restore can never be overwritten", () => {
    const out = html();
    const disabledButtons = out.match(/<button[^>]*disabled=""[^>]*>[^<]*<\/button>/g) ?? [];
    for (const label of ["Lưu bản nháp", "Xoá bản nháp", "Lưu các lựa chọn này làm mặc định", "Đặt lại mặc định", "Tạo video"]) {
      expect(disabledButtons.some((button) => button.includes(label)), label).toBe(true);
    }
    expect(calls.saveDraft).not.toHaveBeenCalled();
    expect(calls.savePreferences).not.toHaveBeenCalled();
  });

  it("starts from the system defaults (VI, 45-65s, 8-12 scenes)", () => {
    const out = html();
    expect(out).toMatch(/<option value="vi" selected="">VI<\/option>/);
    expect(out).toMatch(/<option value="45-65s" selected="">45-65s<\/option>/);
    expect(out).toMatch(/<option value="8-12" selected="">8-12<\/option>/);
  });
});
