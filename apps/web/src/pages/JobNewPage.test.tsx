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
    // a button may hold an icon next to its label
    const disabledButtons = out.match(/<button[^>]*disabled=""[^>]*>[\s\S]*?<\/button>/g) ?? [];
    for (const label of ["Lưu bản nháp", "Xoá bản nháp", "Lưu các lựa chọn này làm mặc định", "Đặt lại mặc định", "Tạo video"]) {
      expect(disabledButtons.some((button) => button.includes(label)), label).toBe(true);
    }
    expect(calls.saveDraft).not.toHaveBeenCalled();
    expect(calls.savePreferences).not.toHaveBeenCalled();
  });

  it("starts from the system defaults (VI, 45-65s, 8-12 scenes)", () => {
    const out = html();
    const chosen = (testId: string) => new RegExp(`data-testid="${testId}"[^]*?<button[^>]*aria-pressed="true"[^>]*>([^<]*)</button>`).exec(out)?.[1];
    expect(chosen("language-choice")).toBe("VI");
    expect(chosen("duration-choice")).toBe("45-65s");
    expect(chosen("scene-count-choice")).toBe("8-12");
  });
});

describe("JobNewPage simple layout", () => {
  it("numbered cards in order - 1 Nội dung, 2 Video (3 Phong cách only in Auto) - then the collapsed technical settings and the defaults", () => {
    const out = html(); // first paint = system defaults = Studio mode
    const at = (testId: string) => out.indexOf(`data-testid="${testId}"`);
    for (const testId of ["section-content", "section-video", "advanced-settings", "defaults-box", "create-summary"]) expect(at(testId), testId).toBeGreaterThan(-1);
    expect(at("section-content")).toBeLessThan(at("section-video"));
    expect(at("section-video")).toBeLessThan(at("advanced-settings"));
    expect(at("advanced-settings")).toBeLessThan(at("defaults-box"));
    expect(at("section-style")).toBe(-1); // template / voice / captions are Auto-only
    expect(out).toContain(locales.vi.jobs.section.content.title);
    expect(out).toContain(locales.vi.jobs.advanced.title);
  });

  it("Auto / Studio sits in the page header; the URL / news search is inside the content card", () => {
    const out = html();
    expect(out.indexOf('data-testid="entry-mode"')).toBeLessThan(out.indexOf('data-testid="section-content"'));
    const content = out.slice(out.indexOf('data-testid="section-content"'), out.indexOf('data-testid="section-video"'));
    expect(content).toContain('data-testid="content-source"');
    expect(content).toContain(locales.vi.intake.embeddedTitle);
  });

  it("the content fields and the summary's submit button belong to the main form; technical settings start collapsed", () => {
    const out = html();
    expect(out).toMatch(/<textarea form="job-new-form"[^>]*required=""/);
    expect(out).toMatch(/<button type="submit"[^>]*form="job-new-form"[^>]*>[\s\S]*?Tạo video/);
    expect(out).not.toMatch(/data-testid="advanced-settings"[^>]*open=""/);
    expect(out).not.toMatch(/<details open=""[^>]*data-testid="advanced-settings"/);
    const summary = out.slice(out.indexOf('data-testid="create-summary"'));
    expect(summary).toContain('data-testid="draft-bar"');
    expect(summary).toContain(locales.vi.jobs.nextStepsTitle); // Studio: what happens next, instead of the Auto checklist
    // phones: a sticky action bar with the same submit (hidden from lg up), saying what is still missing
    const bar = out.slice(out.indexOf('data-testid="mobile-submit"'), out.indexOf('data-testid="create-summary"'));
    expect(out).toMatch(/class="[^"]*lg:hidden[^"]*" data-testid="mobile-submit"/);
    expect(bar).toMatch(/<button type="submit"[^>]*form="job-new-form"/);
    expect(bar).toContain("Còn thiếu 1 mục");
  });
});

describe("JobNewPage colours, icons and progress", () => {
  it("each card has its own accent colour, an icon tile and a step chip", () => {
    const out = html();
    expect(out).toMatch(/class="lyx-section lyx-accent-blue[^"]*"[^>]*data-testid="section-content"/);
    expect(out).toMatch(/class="lyx-section lyx-accent-green[^"]*"[^>]*data-testid="section-video"/);
    expect(out).toMatch(/class="lyx-section lyx-accent-amber[^"]*"[^>]*data-testid="advanced-settings"/);
    expect(out).toMatch(/class="lyx-section lyx-accent-rose[^"]*"[^>]*data-testid="defaults-box"/);
    expect(out.match(/lyx-section-icon/g)?.length).toBeGreaterThanOrEqual(5);
    expect(out).toContain(">Bước 1<");
    expect(out).toContain(">Bước 2<");
  });

  it("the summary shows one coloured progress segment per card (Studio: 2) and an indigo create button", () => {
    const out = html(); // Studio, nothing filled yet
    const strip = out.slice(out.indexOf('data-testid="create-progress"'), out.indexOf("</ul>", out.indexOf('data-testid="create-progress"')));
    expect(strip).toContain("Đã xong 0/2");
    expect(strip.match(/lyx-progress-segment/g)).toHaveLength(2);
    expect(strip).toMatch(/data-done="false" class="lyx-accent-blue/);
    expect(strip).toMatch(/data-done="false" class="lyx-accent-green/);
    expect(out).toMatch(/<button type="submit"[^>]*class="[^"]*lyx-btn-accent/);
  });
});

describe("JobNewPage content source (VE2E-96)", () => {
  it("keeps the create-video form as the page (old layout: form + the 320 px summary column), no permanent news feed", () => {
    const out = html();
    expect(out).toContain("lg:grid-cols-[1fr_320px]");
    expect(out).toContain(locales.vi.jobs.summary);
    expect(out).not.toContain('data-testid="news-feed"');
    expect(out).not.toContain('data-testid="news-drawer"');
    expect(out).not.toContain("create-video-panel");
  });

  it("'Nguồn nội dung' sits above the form: a URL box with [Phân tích] and a news search with [Tìm kiếm]", () => {
    const out = html();
    const sourceAt = out.indexOf('data-testid="content-source"');
    expect(sourceAt).toBeGreaterThan(-1);
    expect(sourceAt).toBeLessThan(out.indexOf('data-testid="draft-bar"'));
    expect(out).toContain(`placeholder="${locales.vi.intake.urlPlaceholder}"`);
    expect(out).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Phân tích<\/button>/); // nothing to analyse yet
    expect(out).toContain(`placeholder="${locales.vi.intake.newsPlaceholder}"`);
    expect(out).toMatch(/<button type="submit"[^>]*>Tìm kiếm<\/button>/);
    expect(calls.api).not.toHaveBeenCalled();
  });
});
