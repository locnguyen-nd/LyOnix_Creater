import type { ApifyPlatformId, ScriptVisualPlanResponse } from "@lyonix/contracts";

/** Platforms offered in the Studio Apify tab, in display order. Google video is preview-only (DEC #11). */
export const APIFY_TAB_PLATFORMS: Array<{ id: ApifyPlatformId; labelKey: string }> = [
  { id: "tiktok", labelKey: "studioPro.apifyPlatformTiktok" },
  { id: "pinterest", labelKey: "studioPro.apifyPlatformPinterest" },
  { id: "x", labelKey: "studioPro.apifyPlatformX" },
  { id: "google_image", labelKey: "studioPro.apifyPlatformGoogleImage" },
  { id: "google_video", labelKey: "studioPro.apifyPlatformGoogleVideo" },
];

/** ja/en keywords of the visual-plan segment that contains the scene (empty strings when the plan has none). */
export function apifyKeywordsForScene(visualPlan: ScriptVisualPlanResponse | null | undefined, sceneId: string | null): { ja: string; en: string } {
  const segment = sceneId ? visualPlan?.segments.find((row) => row.sceneIds.includes(sceneId)) : undefined;
  return { ja: segment?.keywords.ja.trim() ?? "", en: segment?.keywords.en.trim() ?? "" };
}

/** Prefilled keyword for the chosen search language, falling back to the other language when one is empty. */
export function prefillApifyKeyword(keywords: { ja: string; en: string }, lang: "ja" | "en"): string {
  return (lang === "ja" ? keywords.ja || keywords.en : keywords.en || keywords.ja) || "";
}
