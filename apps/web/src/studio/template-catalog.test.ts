import { describe, expect, it } from "vitest";
import { RELEASED_RECIPES } from "@lyonix/render-recipes";
import {
  accountForTemplate,
  categoryCounts,
  filterByCategory,
  normalizeSearch,
  previewSourceKind,
  searchTemplates,
  templateSearchText,
  templateCategory,
  templateReadiness,
  templateSelectionState,
  toLibraryTemplates,
  uniqueTemplates,
} from "./template-catalog";
import type { TemplateEntry } from "./template-gallery";

const recipeId = (id: string) => {
  const recipe = RELEASED_RECIPES.find((item) => item.id === id)!;
  return `recipe:${recipe.id}@${recipe.version}`;
};
const off = { ready: false, reason: "rollout_off", rolloutPercent: 0, hasFallback: false } as const;
const on = { ready: true, reason: null, rolloutPercent: 100, hasFallback: false } as const;

const entry = (accountId: string, engine: TemplateEntry["engine"], externalTemplateId: string, name: string, extra: Partial<TemplateEntry["template"]> = {}): TemplateEntry => ({
  key: `${accountId}:${externalTemplateId}`,
  accountId,
  accountName: `Acc ${accountId}`,
  engine,
  template: { externalTemplateId, name, previewUrl: null, tags: [], ...extra },
});

const library = toLibraryTemplates([
  entry("lx", "lyonix", recipeId("sports-recap-player-focus-jp"), "Player", { tags: ["lyonix", "v1"], internalRender: on }),
  entry("lx", "lyonix", recipeId("breaking-news-red-alert-jp"), "Alert", { tags: ["lyonix", "v1"], internalRender: off }),
  entry("cm1", "creatomate", "cm-news", "News Recap - White Top Caption (JP)", { previewUrl: "https://cdn/x.jpg" }),
  entry("cm2", "creatomate", "cm-news", "News Recap - White Top Caption (JP)", { previewUrl: "https://cdn/x.jpg" }),
  entry("cm1", "creatomate", "cm-misc", "Top 5 countdown"),
  entry("or", "orshot", "or-1", "Breaking News card", { previewUrl: "https://cdn/o.png" }),
]);

describe("template library catalog - web (V04-01)", () => {
  it("groups built-ins from the catalog and provider templates by keyword (breaking before news), else no group", () => {
    expect(library.map((item) => item.category)).toEqual(["sports", "breaking_news", "news", "news", null, "breaking_news"]);
    for (const recipe of RELEASED_RECIPES) expect(templateCategory({ engine: "lyonix", externalTemplateId: `recipe:${recipe.id}@${recipe.version}`, name: recipe.name, tags: [] })).not.toBeNull();
    expect(templateCategory({ engine: "creatomate", externalTemplateId: "x", name: "Match", tags: ["スポーツ"] })).toBe("sports");
    expect(templateCategory({ engine: "creatomate", externalTemplateId: "x", name: "Faceless story", tags: [] })).toBe("faceless");
  });

  it("provider templates: the name decides first, then the tags - news recaps tagged 'faceless' stay news (real Creatomate tags)", () => {
    const creatomate = (name: string, tags: string[]) => templateCategory({ engine: "creatomate", externalTemplateId: "x", name, tags });
    expect(creatomate("News Recap – Photo + Video Mix (JP)", ["news-recap", "vertical", "mixed-media", "photo-video", "telop", "navy", "japanese", "faceless"])).toBe("news");
    expect(creatomate("News Recap – White Top Caption (JP)", ["news-recap", "vertical", "white-bg", "top-caption", "japanese", "faceless"])).toBe("news");
    expect(creatomate("News Recap – Broadcast Telop (JP)", ["news-recap", "vertical", "broadcast", "telop", "navy", "japanese", "faceless"])).toBe("news");
    expect(creatomate("Top 5 Countdown – Japan Vibrant", ["top5", "countdown", "vertical", "vibrant", "japanese", "tiktok", "listicle"])).toBeNull();
    // a deliberate label in the name wins
    expect(creatomate("Faceless News – Fullscreen B-roll", ["news"])).toBe("faceless");
    expect(creatomate("Breaking News – Red Alert", ["faceless"])).toBe("breaking_news");
    // tags only: the subject wins over the production style
    expect(creatomate("Recap A", ["news-recap", "faceless"])).toBe("news");
    expect(creatomate("Story B", ["faceless"])).toBe("faceless");
  });

  describe("search (V04-02)", () => {
    const cards = uniqueTemplates(library);
    const labels = { lyonix: "LyOnix Render", creatomate: "Creatomate", orshot: "Orshot" } as const;
    const groupLabels = { news: "Tin tức", sports: "Thể thao", faceless: "Faceless", breaking_news: "Breaking News" } as const;
    const textOf = (item: (typeof cards)[number]) => templateSearchText(item, { provider: labels[item.engine], category: item.category ? groupLabels[item.category] : null });
    const names = (query: string, items = cards) => searchTemplates(items, query, textOf).map((item) => item.name);

    it("normalises case and Vietnamese diacritics, leaves Japanese / Korean untouched", () => {
      expect(normalizeSearch("  Tin TỨC Đặc biệt ")).toBe("tin tuc dac biet");
      expect(normalizeSearch("Thể thao")).toBe("the thao");
      expect(normalizeSearch("ニュース・ガイド")).toBe("ニュース・ガイド");
      expect(normalizeSearch("뉴스 템플릿")).toBe("뉴스 템플릿");
    });

    it("finds by name, provider, group (id or label, with or without accents), tag and id - case-insensitive", () => {
      expect(names("news")).toEqual(["Alert", "News Recap - White Top Caption (JP)", "Breaking News card"]); // group "breaking news" + names
      expect(names("RECAP")).toEqual(["Player", "News Recap - White Top Caption (JP)"]); // Player: id recipe:sports-recap-player-focus-jp@1
      expect(names("creatomate")).toEqual(["News Recap - White Top Caption (JP)", "Top 5 countdown"]);
      expect(names("orshot")).toEqual(["Breaking News card"]);
      expect(names("lyonix render")).toEqual(["Player", "Alert"]);
      expect(names("sport")).toEqual(["Player"]);
      expect(names("the thao")).toEqual(["Player"]);
      expect(names("Thể Thao")).toEqual(["Player"]);
      expect(names("lower third")).toEqual(["Player"]); // catalog style tag
      expect(names("cm-misc")).toEqual(["Top 5 countdown"]); // external id
      expect(names("zzz")).toEqual([]);
    });

    it("an empty query keeps everything; several words must all match", () => {
      expect(names("")).toHaveLength(cards.length);
      expect(names("   ")).toHaveLength(cards.length);
      expect(names("creatomate news")).toEqual(["News Recap - White Top Caption (JP)"]);
    });

    it("combines with the group filter in either order without changing the source list", () => {
      const sportsThenCreatomate = searchTemplates(filterByCategory(cards, "sports"), "creatomate", textOf);
      expect(sportsThenCreatomate).toEqual([]);
      const breaking = filterByCategory(searchTemplates(cards, "news", textOf), "breaking_news").map((item) => item.name);
      expect(breaking).toEqual(["Alert", "Breaking News card"]);
      expect(cards).toHaveLength(5);
    });
  });

  it("filters by group without touching the list, and counts one card per template", () => {
    const cards = uniqueTemplates(library);
    expect(cards).toHaveLength(5);
    expect(cards.find((item) => item.externalTemplateId === "cm-news")!.accountName).toBe("Acc cm1, Acc cm2");
    expect(categoryCounts(cards)).toEqual({ all: 5, news: 1, sports: 1, faceless: 0, breaking_news: 2 });
    expect(filterByCategory(cards, "breaking_news").map((item) => item.name)).toEqual(["Alert", "Breaking News card"]);
    expect(filterByCategory(cards, "all")).toHaveLength(5);
    expect(cards).toHaveLength(5);
  });

  it("readiness: provider templates are ready (their account is checked by the API), built-ins follow the API's rollout state", () => {
    expect(templateReadiness(library[0]!)).toEqual({ ready: true, hasFallback: false });
    expect(templateReadiness(library[1]!)).toEqual({ ready: false, reason: "rollout_off" });
    expect(templateReadiness(library[2]!)).toEqual({ ready: true, hasFallback: false });
    expect(templateReadiness({ engine: "lyonix", internalRender: { ready: true, reason: null, rolloutPercent: 50, hasFallback: true } })).toEqual({ ready: true, hasFallback: true });
  });

  it("preview source is never the render engine: a LyOnix simulation, the provider's image or SDK, or nothing", () => {
    expect(previewSourceKind(library[0]!, "motion")).toBe("lyonix_simulation");
    expect(previewSourceKind(library[0]!, "picture")).toBe("lyonix_simulation");
    expect(previewSourceKind(library[2]!, "picture")).toBe("creatomate_image");
    expect(previewSourceKind(library[2]!, "motion")).toBe("creatomate_motion");
    expect(previewSourceKind(library[4]!, "picture")).toBe("none");
    expect(previewSourceKind(library[5]!, "picture")).toBe("orshot_image");
  });

  it("selection state: compatible + ready = ok; another account = incompatible (kept, not cleared); rollout 0 = not ready; gone = missing", () => {
    expect(templateSelectionState(library, "", "lx")).toEqual({ kind: "none" });
    expect(templateSelectionState(library, "gone", "lx")).toEqual({ kind: "missing" });
    expect(templateSelectionState(library, recipeId("sports-recap-player-focus-jp"), "lx")).toMatchObject({ kind: "ok" });
    expect(templateSelectionState(library, recipeId("sports-recap-player-focus-jp"), "cm1")).toMatchObject({ kind: "incompatible", template: { accountId: "lx" } });
    expect(templateSelectionState(library, recipeId("breaking-news-red-alert-jp"), "lx")).toMatchObject({ kind: "not_ready", reason: "rollout_off" });
    expect(templateSelectionState(library, "cm-news", "cm2")).toMatchObject({ kind: "ok", template: { accountId: "cm2" } });
  });

  it("'Chọn template này' uses the template's account; with several: the current one, else the user's default, else ask", () => {
    expect(accountForTemplate(library, recipeId("sports-recap-player-focus-jp"), { currentAccountId: "cm1" })).toEqual({ kind: "one", accountId: "lx" });
    expect(accountForTemplate(library, "cm-news", { currentAccountId: "cm2", defaultAccountId: "cm1" })).toEqual({ kind: "one", accountId: "cm2" });
    expect(accountForTemplate(library, "cm-news", { currentAccountId: "lx", defaultAccountId: "cm1" })).toEqual({ kind: "one", accountId: "cm1" });
    expect(accountForTemplate(library, "cm-news", { currentAccountId: "lx", defaultAccountId: "or" })).toEqual({ kind: "ask", accountIds: ["cm1", "cm2"] });
    expect(accountForTemplate(library, "gone", {})).toEqual({ kind: "none" });
  });
});
