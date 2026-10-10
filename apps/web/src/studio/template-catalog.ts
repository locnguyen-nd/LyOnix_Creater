/**
 * V04-01: what the template library shows about a template - pure, no DOM, no network:
 *  - its group (category): internal recipes from the catalog (@lyonix/render-recipes), provider templates by keywords in the name, then the tags;
 *  - whether it can be applied / rendered now (internal templates carry the API's readiness; the API re-checks with the same rule);
 *  - the render engine and, SEPARATELY, where the preview comes from (a LyOnix simulation is never presented as a provider render);
 *  - template <-> render account compatibility and which account "Chọn template này" uses.
 */
import { recipeCatalogEntry, TEMPLATE_CATEGORIES, type TemplateCategory } from "@lyonix/render-recipes";
import type { TemplateRenderBlockReason } from "@lyonix/contracts";
import type { TemplateEntry } from "./template-gallery";
import { recipeFromExternalId, type PreviewableTemplate } from "./template-preview";

export { TEMPLATE_CATEGORIES, type TemplateCategory };
export type CategoryFilter = TemplateCategory | "all";
export const CATEGORY_FILTERS: readonly CategoryFilter[] = ["all", ...TEMPLATE_CATEGORIES];

const KEYWORDS: Readonly<Record<TemplateCategory, RegExp>> = {
  breaking_news: /breaking|速報|urgent|khẩn|alert/i,
  sports: /sport|スポーツ|thể thao|football|soccer|baseball|basketball|volleyball|サッカー|野球/i,
  faceless: /faceless|b-?roll/i,
  news: /news|ニュース|tin tức|bản tin/i,
};
/** In a template's NAME "Faceless" is a deliberate label ("Faceless News – Fullscreen B-roll" is faceless); breaking before news ("Breaking News"). */
const NAME_ORDER: readonly TemplateCategory[] = ["breaking_news", "sports", "faceless", "news"];
/** In TAGS "faceless" is a production style news recaps also carry (["news-recap", ..., "faceless"]), so the subject (news) wins. */
const TAG_ORDER: readonly TemplateCategory[] = ["breaking_news", "sports", "news", "faceless"];
const firstMatch = (text: string, order: readonly TemplateCategory[]): TemplateCategory | null => order.find((category) => KEYWORDS[category].test(text)) ?? null;

/** Group of a template: internal recipes from the catalog; provider templates by keywords in their name first, then in their tags. */
export function templateCategory(template: Pick<PreviewableTemplate, "engine" | "externalTemplateId" | "name" | "tags">): TemplateCategory | null {
  if (template.engine === "lyonix") {
    const recipe = recipeFromExternalId(template.externalTemplateId);
    return recipe ? (recipeCatalogEntry(recipe.id)?.category ?? null) : null;
  }
  return firstMatch(template.name, NAME_ORDER) ?? firstMatch(template.tags.join(" "), TAG_ORDER);
}

/** Style tags to show: the catalog's for an internal recipe (not the technical "lyonix" / "v1"), the provider's own otherwise. */
export function templateStyleTags(template: Pick<PreviewableTemplate, "engine" | "externalTemplateId" | "tags">): readonly string[] {
  if (template.engine !== "lyonix") return template.tags;
  const recipe = recipeFromExternalId(template.externalTemplateId);
  return (recipe && recipeCatalogEntry(recipe.id)?.styleTags) || [];
}

export const templateLanguages = (template: Pick<PreviewableTemplate, "engine" | "externalTemplateId">): readonly string[] => {
  if (template.engine !== "lyonix") return [];
  const recipe = recipeFromExternalId(template.externalTemplateId);
  return (recipe && recipeCatalogEntry(recipe.id)?.languages) || [];
};

/** Recipe id of an internal template (key of its description / "suited for" texts), or null. */
export const templateRecipeId = (template: Pick<PreviewableTemplate, "engine" | "externalTemplateId">): string | null =>
  template.engine === "lyonix" ? (recipeFromExternalId(template.externalTemplateId)?.id ?? null) : null;

export type TemplateReadiness = { ready: true; hasFallback: boolean } | { ready: false; reason: TemplateRenderBlockReason };

/** Can it be applied / rendered now? Provider templates: yes (their account is checked by the API); internal ones: the API's rollout readiness. */
export function templateReadiness(template: Pick<PreviewableTemplate, "engine" | "internalRender">): TemplateReadiness {
  if (template.engine !== "lyonix" || !template.internalRender) return { ready: true, hasFallback: false };
  const state = template.internalRender;
  return state.ready ? { ready: true, hasFallback: state.hasFallback } : { ready: false, reason: state.reason ?? "rollout_off" };
}

/**
 * Can this template be chosen ("Dùng template" / "Chọn template này" / double click)? The same readiness the preview modal and the API
 * use: a template that cannot render now is never chosen, so Auto never stores it and Studio never pins it.
 */
export type TemplateChoice = { ok: true } | { ok: false; reason: "current" } | { ok: false; reason: "not_ready"; blockReason: TemplateRenderBlockReason };

export function templateChoice(template: Pick<PreviewableTemplate, "engine" | "internalRender" | "externalTemplateId">, selectedId: string | null | undefined): TemplateChoice {
  const readiness = templateReadiness(template);
  if (!readiness.ready) return { ok: false, reason: "not_ready", blockReason: readiness.reason };
  if (selectedId && template.externalTemplateId === selectedId) return { ok: false, reason: "current" };
  return { ok: true };
}

/**
 * After the template lists (re)load (page reload, render account list changed): the chosen / restored template is KEPT when a list
 * still has it - even when it cannot render now (Auto shows why and stays blocked; it is never swapped for another template) - or
 * when a list failed to load (unknown). Only a template no list has any more is cleared (VE2E-124, reported to the user).
 */
export const keepsTemplateAfterLoad = (templateId: string, listedTemplateIds: readonly string[], anyListFailed: boolean): boolean =>
  !templateId || anyListFailed || listedTemplateIds.includes(templateId);

/** "x / y template sẵn sàng render" of a list. */
export const readinessCount = (items: ReadonlyArray<Pick<PreviewableTemplate, "engine" | "internalRender">>): { ready: number; total: number } => ({
  ready: items.filter((item) => templateReadiness(item).ready).length,
  total: items.length,
});

/** Where the picture / motion shown comes from - never the render engine itself. */
export type PreviewSourceKind = "lyonix_simulation" | "creatomate_image" | "creatomate_motion" | "orshot_image" | "none";

export function previewSourceKind(template: Pick<PreviewableTemplate, "engine" | "previewUrl" | "externalTemplateId">, tab: "picture" | "motion"): PreviewSourceKind {
  if (template.engine === "lyonix") return recipeFromExternalId(template.externalTemplateId) ? "lyonix_simulation" : "none";
  if (template.engine === "creatomate" && tab === "motion") return "creatomate_motion";
  if (!template.previewUrl) return "none";
  return template.engine === "orshot" ? "orshot_image" : "creatomate_image";
}

export const categoryCounts = <T extends { category: TemplateCategory | null }>(items: readonly T[]): Record<CategoryFilter, number> => {
  const counts = Object.fromEntries(CATEGORY_FILTERS.map((filter) => [filter, 0])) as Record<CategoryFilter, number>;
  for (const item of items) {
    counts.all += 1;
    if (item.category) counts[item.category] += 1;
  }
  return counts;
};

/** The filter only changes what is listed - never the selection. */
export const filterByCategory = <T extends { category: TemplateCategory | null }>(items: readonly T[], filter: CategoryFilter): T[] =>
  filter === "all" ? [...items] : items.filter((item) => item.category === filter);

/** A library entry for the preview modal / cards: the template, its engine, account and group. */
export type LibraryTemplate = PreviewableTemplate & { key: string; accountId: string; category: TemplateCategory | null };

export const toLibraryTemplates = (entries: readonly TemplateEntry[]): LibraryTemplate[] =>
  entries.map((entry) => {
    const item = { ...entry.template, engine: entry.engine, accountName: entry.accountName };
    return { ...item, key: entry.key, accountId: entry.accountId, category: templateCategory(item) };
  });

/**
 * One card per template: the same template listed by several render accounts (e.g. two keys of one Creatomate project) shows once,
 * naming every account; "Chọn template này" then resolves the account with `accountForTemplate`.
 */
export function uniqueTemplates(items: readonly LibraryTemplate[]): LibraryTemplate[] {
  const byId = new Map<string, LibraryTemplate>();
  for (const item of items) {
    const seen = byId.get(item.externalTemplateId);
    if (!seen) byId.set(item.externalTemplateId, item);
    else if (item.accountName && !seen.accountName?.split(", ").includes(item.accountName)) byId.set(item.externalTemplateId, { ...seen, accountName: [seen.accountName, item.accountName].filter(Boolean).join(", ") });
  }
  return [...byId.values()];
}

/** State of the chosen template against the chosen render account (Auto is blocked unless `ok`). */
export type TemplateSelectionState =
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "incompatible"; template: LibraryTemplate }
  | { kind: "not_ready"; template: LibraryTemplate; reason: TemplateRenderBlockReason }
  | { kind: "ok"; template: LibraryTemplate };

export function templateSelectionState(items: readonly LibraryTemplate[], templateId: string, renderAccountId: string): TemplateSelectionState {
  if (!templateId) return { kind: "none" };
  const matches = items.filter((item) => item.externalTemplateId === templateId);
  if (matches.length === 0) return { kind: "missing" };
  const own = matches.find((item) => item.accountId === renderAccountId);
  if (!own) return { kind: "incompatible", template: matches[0]! };
  const readiness = templateReadiness(own);
  return readiness.ready ? { kind: "ok", template: own } : { kind: "not_ready", template: own, reason: readiness.reason };
}

/**
 * Render account used by "Chọn template này": the template's own account. With several accounts listing the same template: the one
 * already selected (nothing changes), else the user's default render account, else the user is asked - never a silent pick.
 */
export type TemplateAccountChoice = { kind: "one"; accountId: string } | { kind: "ask"; accountIds: string[] } | { kind: "none" };

export function accountForTemplate(items: readonly LibraryTemplate[], templateId: string, prefs: { currentAccountId?: string | null; defaultAccountId?: string | null }): TemplateAccountChoice {
  const accountIds = [...new Set(items.filter((item) => item.externalTemplateId === templateId).map((item) => item.accountId))];
  if (accountIds.length === 0) return { kind: "none" };
  if (accountIds.length === 1) return { kind: "one", accountId: accountIds[0]! };
  if (prefs.currentAccountId && accountIds.includes(prefs.currentAccountId)) return { kind: "one", accountId: prefs.currentAccountId };
  if (prefs.defaultAccountId && accountIds.includes(prefs.defaultAccountId)) return { kind: "one", accountId: prefs.defaultAccountId };
  return { kind: "ask", accountIds };
}
