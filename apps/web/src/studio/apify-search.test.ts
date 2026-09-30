import { describe, expect, it } from "vitest";
import type { ScriptVisualPlanResponse } from "@lyonix/contracts";
import { APIFY_TAB_PLATFORMS, apifyKeywordsForScene, prefillApifyKeyword } from "./apify-search";

const plan: ScriptVisualPlanResponse = {
  segments: [
    { segmentId: "g1", sceneIds: ["s1", "s2"], subject: "city", priority: 1, keywords: { ja: "東京 夜景", en: "Tokyo night" }, styleHints: { setting: "", timeOfDay: "", lighting: "", palette: "" } },
    { segmentId: "g2", sceneIds: ["s3"], subject: "food", priority: 2, keywords: { ja: "", en: "ramen" }, styleHints: { setting: "", timeOfDay: "", lighting: "", palette: "" } },
  ],
};

describe("Studio Apify tab helpers", () => {
  it("reads the ja/en keywords of the segment containing the scene", () => {
    expect(apifyKeywordsForScene(plan, "s2")).toEqual({ ja: "東京 夜景", en: "Tokyo night" });
    expect(apifyKeywordsForScene(plan, "s3")).toEqual({ ja: "", en: "ramen" });
    expect(apifyKeywordsForScene(plan, "missing")).toEqual({ ja: "", en: "" });
    expect(apifyKeywordsForScene(null, "s1")).toEqual({ ja: "", en: "" });
    expect(apifyKeywordsForScene(plan, null)).toEqual({ ja: "", en: "" });
  });

  it("prefills the keyword for the language and falls back to the other one", () => {
    expect(prefillApifyKeyword({ ja: "東京 夜景", en: "Tokyo night" }, "ja")).toBe("東京 夜景");
    expect(prefillApifyKeyword({ ja: "東京 夜景", en: "Tokyo night" }, "en")).toBe("Tokyo night");
    expect(prefillApifyKeyword({ ja: "", en: "ramen" }, "ja")).toBe("ramen");
    expect(prefillApifyKeyword({ ja: "", en: "" }, "ja")).toBe("");
  });

  it("offers exactly the five supported platforms", () => {
    expect(APIFY_TAB_PLATFORMS.map((p) => p.id)).toEqual(["tiktok", "pinterest", "x", "google_image", "google_video"]);
  });
});
