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

/**
 * V04-02: text normalisation of the template search - lower case, Vietnamese diacritics folded ("Tin tức" ~ "tin tuc", "đ" ~ "d").
 * Only combining marks of the Latin range (U+0300-U+036F) are dropped, then the text is recomposed (NFC), so kana voicing marks and
 * Hangul syllables come back unchanged.
 */
export const normalizeSearch = (value: string): string =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").normalize("NFC").toLowerCase().trim();

/** Everything a template can be found by: name, provider (id + shown name), group (id + label), tags, style tags, id, account. */
export function templateSearchText(
  template: Pick<LibraryTemplate, "name" | "engine" | "category" | "tags" | "externalTemplateId"> & { accountName?: string },
  labels: { provider: string; category: string | null },
): string {
  return normalizeSearch(
    [template.name, template.engine, labels.provider, template.category?.replace(/_/g, " ") ?? "", labels.category ?? "", ...template.tags, ...templateStyleTags(template), template.externalTemplateId, template.accountName ?? ""].join(" \u0001 "),
  );
}

/** Client-side search of the loaded list (no request per keystroke): every term of the query must appear; an empty query keeps all. */
export function searchTemplates<T>(items: readonly T[], query: string, textOf: (item: T) => string): T[] {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items.filter((item) => {
    const text = textOf(item);
    return terms.every((term) => text.includes(term));
  });
}

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
