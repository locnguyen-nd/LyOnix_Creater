import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import { RELEASED_RECIPES, recipeCatalogEntry } from "@lyonix/render-recipes";
import type { CreatomateTemplateSummaryResponse } from "@lyonix/contracts";

// The library as the dev database had it (2026-10-10): 8 LyOnix Render recipes, only white-top-caption switched on (100 %);
// 3 Creatomate templates on the admin's Creatomate account. Local fixture only - no request, no render.
const api = vi.hoisted(() => ({ pinTemplateSnapshot: vi.fn(), fetchCreatomatePreviewConfig: vi.fn(async () => ({ configured: false, publicToken: null })) }));
vi.mock("../studio/timeline-api", () => api);

const { TemplateBrowser, filterTemplates } = await import("./TemplateBrowser");
const { TemplatePicker } = await import("./TemplatePicker");
const { accountForTemplate, keepsTemplateAfterLoad, templateCategory, templateChoice, templateReadiness, templateSelectionState, toLibraryTemplates, readinessCount } = await import("../studio/template-catalog");
const { mergeTemplateEntries } = await import("../studio/template-gallery");
const { buildInitialFormState } = await import("../job-new/form-state");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);

const LYONIX = { id: "lyonix-acct", name: "LyOnix (tự render)", provider: "lyonix" };
const CREATOMATE = { id: "cm-acct", name: "CREATOMATE", provider: "creatomate" };
const WHITE_TOP = "recipe:news-recap-white-top-caption-jp@1";
const URGENT = "recipe:breaking-news-urgent-headline-jp@1";
const recipeIds = RELEASED_RECIPES.map((recipe) => `recipe:${recipe.id}@${recipe.version}`);

const internalList: CreatomateTemplateSummaryResponse[] = RELEASED_RECIPES.map((recipe) => {
  const externalTemplateId = `recipe:${recipe.id}@${recipe.version}`;
  const on = externalTemplateId === WHITE_TOP;
  return { externalTemplateId, name: recipe.name, previewUrl: null, tags: ["lyonix", `v${recipe.version}`], internalRender: on ? { ready: true, reason: null, rolloutPercent: 100, hasFallback: false } : { ready: false, reason: "rollout_off", rolloutPercent: 0, hasFallback: false } };
});
const creatomateList: CreatomateTemplateSummaryResponse[] = [
  { externalTemplateId: "cm-mix", name: "News Recap – Photo + Video Mix (JP)", previewUrl: "https://cdn.example/mix.jpg", tags: ["news-recap", "faceless"] },
  { externalTemplateId: "cm-telop", name: "News Recap – Broadcast Telop (JP)", previewUrl: "https://cdn.example/telop.jpg", tags: ["news-recap"] },
  { externalTemplateId: "cm-white", name: "News Recap – White Top Caption (JP)", previewUrl: null, tags: ["news-recap"] },
];
const library = (withCreatomate = true) => toLibraryTemplates(mergeTemplateEntries(withCreatomate ? [LYONIX, CREATOMATE] : [LYONIX], withCreatomate ? [internalList, creatomateList] : [internalList]));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("template library: all 8 default templates, which ones can be used", () => {
  it("the drawer lists the 8 LyOnix Render templates (+ the Creatomate ones), says how many can render and labels every other card", () => {
    const onlyInternal = wrap(<TemplateBrowser templates={library(false)} chooseLabel="Dùng template" onChoose={() => undefined} />);
    expect(count(onlyInternal, 'data-testid="template-mini-card"')).toBe(8);
    expect(onlyInternal).toContain("1/8 template sẵn sàng render");
    expect(count(onlyInternal, 'data-testid="template-mini-not-ready"')).toBe(7);
    expect(count(onlyInternal, 'data-ready="true"')).toBe(1);
    const all = wrap(<TemplateBrowser templates={library()} chooseLabel="Dùng template" onChoose={() => undefined} />);
    expect(count(all, 'data-testid="template-mini-card"')).toBe(11);
    expect(all).toContain("4/11 template sẵn sàng render");
    expect(all).toContain('data-testid="template-ready-only"');
  });

  it.each(recipeIds)("%s: id, engine LyOnix Render, group and readiness are exactly the API's", (externalTemplateId) => {
    const item = library().find((entry) => entry.externalTemplateId === externalTemplateId)!;
    const recipeId = externalTemplateId.slice("recipe:".length, externalTemplateId.lastIndexOf("@"));
    expect(item).toMatchObject({ externalTemplateId, engine: "lyonix", accountId: LYONIX.id });
    expect(templateCategory(item)).toBe(recipeCatalogEntry(recipeId)?.category);
    const ready = externalTemplateId === WHITE_TOP;
    expect(templateReadiness(item)).toEqual(ready ? { ready: true, hasFallback: false } : { ready: false, reason: "rollout_off" });
    expect(templateChoice(item, null)).toEqual(ready ? { ok: true } : { ok: false, reason: "not_ready", blockReason: "rollout_off" });
  });

  it("Creatomate templates keep their own engine (never shown as LyOnix) and are ready (their account is checked by the API)", () => {
    for (const item of library().filter((entry) => entry.accountId === CREATOMATE.id)) {
      expect(item.engine).toBe("creatomate");
      expect(templateChoice(item, null)).toEqual({ ok: true });
    }
  });

  it("'Breaking news - urgent headline' (restored from the defaults): the details say why and the choose button is disabled - it cannot be chosen", () => {
    const onChoose = vi.fn();
    const html = wrap(<TemplateBrowser templates={library()} selectedId={URGENT} chooseLabel="Dùng template" onChoose={onChoose} />);
    const detail = html.slice(html.indexOf('data-testid="template-browser-detail"'));
    expect(detail).toContain("Breaking news - urgent headline (JP)");
    expect(detail).toContain("rollout 0 %");
    expect(detail).toMatch(/<button[^>]*disabled=""[^>]*data-testid="template-browser-choose"[^>]*>Chưa sẵn sàng render<\/button>/);
    expect(templateChoice(library().find((item) => item.externalTemplateId === URGENT)!, URGENT)).toMatchObject({ ok: false, reason: "not_ready" });
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("the template in use shows 'Đang dùng' (disabled); a ready one can be chosen", () => {
    const current = wrap(<TemplateBrowser templates={library()} selectedId={WHITE_TOP} chooseLabel="Dùng template" onChoose={() => undefined} />);
    expect(current).toMatch(/<button[^>]*disabled=""[^>]*data-testid="template-browser-choose"[^>]*>Đang dùng<\/button>/);
    const whiteTop = library().find((item) => item.externalTemplateId === WHITE_TOP)!;
    expect(templateChoice(whiteTop, null)).toEqual({ ok: true });
    expect(templateChoice(whiteTop, WHITE_TOP)).toEqual({ ok: false, reason: "current" });
  });

  it("'Chỉ template dùng được' keeps only the templates that can render now", () => {
    const visible = filterTemplates(library(), { query: "", engine: "all", category: "all", readyOnly: true });
    expect(visible.map((item) => item.externalTemplateId)).toEqual([WHITE_TOP, "cm-telop", "cm-mix", "cm-white"]);
    expect(readinessCount(library(false))).toEqual({ ready: 1, total: 8 });
  });

  it("the chosen template's chip names it and keeps the not-ready badge (nothing is swapped for a default)", () => {
    const chip = wrap(<TemplatePicker templates={library()} selectedId={URGENT} onChoose={() => undefined} />);
    expect(chip).toContain("Breaking news - urgent headline (JP)");
    expect(chip).toContain('data-testid="template-not-ready"');
    expect(chip).toContain("LyOnix Render");
  });
});

describe("the choice survives: switching, closing / reopening the drawer, reloading the page", () => {
  it.each([...recipeIds, "cm-mix"])("%s: chosen with its own render account; the selection state points at exactly that template", (externalTemplateId) => {
    const items = library();
    const choice = accountForTemplate(items, externalTemplateId, { currentAccountId: CREATOMATE.id, defaultAccountId: null });
    const accountId = externalTemplateId.startsWith("recipe:") ? LYONIX.id : CREATOMATE.id;
    expect(choice).toEqual({ kind: "one", accountId });
    const state = templateSelectionState(items, externalTemplateId, accountId);
    expect(state.kind === "ok" || state.kind === "not_ready" ? state.template.externalTemplateId : null).toBe(externalTemplateId);
    expect(state.kind).toBe(externalTemplateId === URGENT || (externalTemplateId.startsWith("recipe:") && externalTemplateId !== WHITE_TOP) ? "not_ready" : "ok");
  });

  it("reload: the saved template + account come back from the defaults / draft and stay chosen once the lists load (even a not-ready one)", () => {
    const lists = { channelIds: [], contentIds: ["c-1"], voiceIds: [], mediaIds: [], renderIds: [LYONIX.id, CREATOMATE.id] };
    for (const templateId of [WHITE_TOP, URGENT, "cm-telop"]) {
      const renderAccountId = templateId.startsWith("recipe:") ? LYONIX.id : CREATOMATE.id;
      const { values } = buildInitialFormState({ preferences: { entryMode: "auto", renderAccountId, templateId }, lists });
      expect(values).toMatchObject({ renderAccountId, templateId });
      expect(keepsTemplateAfterLoad(values.templateId, library().map((item) => item.externalTemplateId), false)).toBe(true);
    }
    // a template no list has any more is cleared (and reported); a failed list never clears the choice
    expect(keepsTemplateAfterLoad("recipe:gone@1", library().map((item) => item.externalTemplateId), false)).toBe(false);
    expect(keepsTemplateAfterLoad("recipe:gone@1", [], true)).toBe(true);
  });

  it("rendering the drawer / picker never chooses anything by itself", () => {
    const onChoose = vi.fn();
    wrap(<TemplatePicker templates={library()} selectedId={WHITE_TOP} onChoose={onChoose} />);
    wrap(<TemplateBrowser templates={library()} selectedId={WHITE_TOP} chooseLabel="Dùng template" onChoose={onChoose} />);
    expect(onChoose).not.toHaveBeenCalled();
    expect(api.pinTemplateSnapshot).not.toHaveBeenCalled();
  });
});

describe("labels name the engine of the template, not a provider", () => {
  it("the Auto fields no longer say 'Creatomate/Orshot' (the default library is LyOnix Render; each card shows its engine)", () => {
    for (const locale of ["vi", "en"] as const) {
      const jobs = locales[locale].jobs as Record<string, unknown>;
      expect(String(jobs.autoTemplate)).not.toMatch(/Creatomate|Orshot/);
      expect(String((jobs.autoPreflight as Record<string, string>).render)).not.toMatch(/Creatomate|Orshot/);
    }
  });
});
