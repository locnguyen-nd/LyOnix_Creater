import { RELEASED_RECIPES } from "@lyonix/render-recipes";
import { buildOverlayDocuments } from "./overlays.js";
import { makePlan, testRecipe, type FixtureFiles } from "./test-fixtures.js";

/**
 * VE2E-93: regression cases for the burned-in text of a render. `overlays-baseline.json` holds the output of these cases captured
 * BEFORE VE2E-93 changed the caption code; a timeline without any VE2E-93 style key must keep producing exactly those bytes.
 * VE2E-157 (`compose.v2`) adds motion tags + animated box documents on top: `layers` keeps the TEXT layers only, and the test strips the
 * motion tags before comparing, so line breaks / sizes / styles are still pinned byte for byte.
 * Test-only (never imported by runtime code); no FFmpeg needed - only the plan's structure is read.
 */

const files: FixtureFiles = {
  image: "projects/p/still.jpg",
  landscape: "projects/p/landscape.mp4",
  portraitShort: "projects/p/portrait-short.mp4",
  voices: ["projects/p/voice0.mp3", "projects/p/voice1.mp3", "projects/p/voice2.mp3"],
  music: "projects/p/music.wav",
};

const TEXTS = [
  "今日の注目ニュースをわかりやすく紹介します。背景と今後の動きを短くまとめました。",
  "Messi is a football player who plays for Inter Miami now.",
  "続きは動画の最後までご覧ください",
];

const timedPlan = () => {
  const plan = makePlan(files, { texts: TEXTS });
  plan.scenes[0]!.captionCues = [
    { text: "今日の注目ニュースを", startMs: 0, endMs: 1200 },
    { text: "わかりやすく紹介します。", startMs: 1200, endMs: 2800 },
  ];
  plan.scenes[1]!.captionCues = [
    { text: "Messi is", startMs: 0, endMs: 800, charTimings: Array.from("Messi is").map((_, i) => ({ startMs: i * 100, endMs: i * 100 + 90 })) },
    { text: "a football player.", startMs: 800, endMs: 2400 },
  ];
  return plan;
};

const PARAM_SETS: Record<string, Record<string, string>> = {
  none: {},
  legacyFontColor: { "dynamicStyle.captionFontFamily": "M PLUS Rounded 1c", "dynamicStyle.captionFillColor": "#00FF00" },
  legacyBadFont: { "dynamicStyle.captionFontFamily": "Evil,Font;{\\b1}", "dynamicStyle.captionFillColor": "#ff000080" },
  slots: { headline: "速報 テスト", badge: "NEWS", score: "2-1" },
};

export type OverlayBaselineCase = { name: string; captions: string | null; layers: string[]; warnings: string[] };

export function overlayBaselineCases(): OverlayBaselineCase[] {
  const recipes = [testRecipe("Noto Sans JP"), ...RELEASED_RECIPES];
  const cases: OverlayBaselineCase[] = [];
  for (const recipe of recipes) {
    for (const [paramName, params] of Object.entries(PARAM_SETS)) {
      for (const [planName, plan] of [["static", makePlan(files, { texts: TEXTS })], ["timed", timedPlan()]] as const) {
        const docs = buildOverlayDocuments(plan, recipe, params);
        cases.push({ name: `${recipe.id}@${recipe.version}/${paramName}/${planName}`, captions: docs.captions?.ass ?? null, layers: docs.layers.filter((layer) => layer.kind === "text").map((layer) => layer.ass), warnings: docs.warnings });
      }
    }
  }
  return cases;
}
