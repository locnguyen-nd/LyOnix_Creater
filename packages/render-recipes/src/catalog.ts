/**
 * V04-01: template library metadata of the released recipes - group (category), style tags, languages and the preview pacing - kept
 * OUTSIDE the recipe files so released recipes stay immutable (their digests are pinned). Pure data, browser-safe.
 *
 * Previews are a simulation drawn in the browser from the recipe itself: a preset only sets the PACING of the loop (how many sample
 * scenes, how long each, photo or clip). It never adds an effect - every visible effect (zoom, transition, caption highlight / colour)
 * comes from the recipe, i.e. from what the internal engine really renders.
 */

export const TEMPLATE_CATEGORIES = ["news", "sports", "faceless", "breaking_news"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const PREVIEW_PRESET_IDS = ["news-clean", "sports-energy", "faceless-zoom", "breaking-alert"] as const;
export type PreviewPresetId = (typeof PREVIEW_PRESET_IDS)[number];

/** Pacing of a preview loop: scene length and, per sample scene, whether it stands for a photo or a clip (the recipe moves them differently). */
export type PreviewPreset = { id: PreviewPresetId; sceneMs: number; scenes: ReadonlyArray<"image" | "video"> };

export const PREVIEW_PRESETS: Readonly<Record<PreviewPresetId, PreviewPreset>> = {
  "news-clean": { id: "news-clean", sceneMs: 2400, scenes: ["image", "image", "image"] },
  "sports-energy": { id: "sports-energy", sceneMs: 2000, scenes: ["image", "video", "image"] },
  "faceless-zoom": { id: "faceless-zoom", sceneMs: 3500, scenes: ["video", "image"] },
  "breaking-alert": { id: "breaking-alert", sceneMs: 2000, scenes: ["image", "image", "image"] },
};

/** Total loop length of a preset (5..8 s by design). */
export const presetLoopMs = (preset: PreviewPreset): number => preset.sceneMs * preset.scenes.length;

/** Neutral sample content per group, used ONLY to illustrate a template - never written to a job, a draft or the user's defaults. */
export type CatalogSample = { headline: string; captions: readonly string[] };

export const CATEGORY_SAMPLES: Readonly<Record<TemplateCategory, CatalogSample>> = {
  news: { headline: "最新ニュースを60秒で解説", captions: ["今日の注目ニュースをわかりやすく紹介します", "背景と今後の動きを短くまとめました", "続きは動画の最後までご覧ください"] },
  sports: { headline: "試合のハイライト", captions: ["注目プレーを振り返ります", "後半の逆転劇をチェックしましょう", "次の試合の見どころも紹介します"] },
  faceless: { headline: "今日の話題", captions: ["映像と字幕でわかりやすく解説", "知っておきたいポイントは三つです", "最後まで見るとよくわかります"] },
  breaking_news: { headline: "最新情報が入りました", captions: ["現在わかっている情報をお伝えします", "続報が入りしだいお知らせします", "引き続き最新情報にご注意ください"] },
};

export type RecipeCatalogEntry = {
  recipeId: string;
  category: TemplateCategory;
  /** Short style tags shown on the preview (not translated: layout vocabulary). */
  styleTags: readonly string[];
  /** Script languages the recipe is designed for (its fonts / sample layout). */
  languages: readonly string[];
  previewPreset: PreviewPresetId;
};

export const RECIPE_CATALOG: readonly RecipeCatalogEntry[] = [
  { recipeId: "news-recap-white-top-caption-jp", category: "news", styleTags: ["top caption", "picture band", "badge"], languages: ["ja"], previewPreset: "news-clean" },
  { recipeId: "news-recap-broadcast-telop-jp", category: "news", styleTags: ["telop", "headline band", "word highlight"], languages: ["ja"], previewPreset: "news-clean" },
  { recipeId: "news-recap-photo-video-mix-jp", category: "faceless", styleTags: ["fullscreen", "b-roll", "lower plate", "word highlight"], languages: ["ja"], previewPreset: "faceless-zoom" },
  { recipeId: "faceless-story-caption-center-jp", category: "faceless", styleTags: ["fullscreen", "b-roll", "center caption"], languages: ["ja"], previewPreset: "faceless-zoom" },
  { recipeId: "sports-highlight-score-headline-jp", category: "sports", styleTags: ["headline band", "score headline", "word highlight"], languages: ["ja"], previewPreset: "sports-energy" },
  { recipeId: "sports-recap-player-focus-jp", category: "sports", styleTags: ["lower third", "push-in zoom", "word highlight"], languages: ["ja"], previewPreset: "sports-energy" },
  { recipeId: "breaking-news-red-alert-jp", category: "breaking_news", styleTags: ["alert band", "headline box", "colour per scene"], languages: ["ja"], previewPreset: "breaking-alert" },
  { recipeId: "breaking-news-urgent-headline-jp", category: "breaking_news", styleTags: ["big headline", "picture band", "colour per scene"], languages: ["ja"], previewPreset: "breaking-alert" },
];

const BY_RECIPE = new Map(RECIPE_CATALOG.map((entry) => [entry.recipeId, entry]));

/** Catalog entry of a recipe id, or null (a recipe without an entry is listed under "all" only). */
export const recipeCatalogEntry = (recipeId: string): RecipeCatalogEntry | null => BY_RECIPE.get(recipeId) ?? null;
