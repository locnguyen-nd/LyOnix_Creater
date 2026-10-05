import { describe, expect, it } from "vitest";
import { RELEASED_RECIPES } from "@lyonix/render-recipes";
import { canShowMotionPreview, recipeFromExternalId, stepIndex, templatePreviewSource, type PreviewableTemplate } from "./template-preview";

const tpl = (overrides: Partial<PreviewableTemplate>): PreviewableTemplate => ({ externalTemplateId: "t1", name: "T1", previewUrl: null, tags: [], engine: "creatomate", ...overrides });

describe("template preview source (V04-XX)", () => {
  it("maps every released LyOnix recipe id back to its recipe", () => {
    for (const recipe of RELEASED_RECIPES) expect(recipeFromExternalId(`recipe:${recipe.id}@${recipe.version}`)).toBe(recipe);
    expect(recipeFromExternalId("recipe:unknown@1")).toBeNull();
    expect(recipeFromExternalId("tpl_123")).toBeNull();
  });

  it("LyOnix -> recipe simulation; Creatomate/Orshot -> their image; nothing -> fallback", () => {
    const recipe = RELEASED_RECIPES[0]!;
    expect(templatePreviewSource(tpl({ engine: "lyonix", externalTemplateId: `recipe:${recipe.id}@${recipe.version}` }))).toEqual({ kind: "recipe", recipe });
    expect(templatePreviewSource(tpl({ engine: "creatomate", previewUrl: "https://cdn/x.jpg" }))).toEqual({ kind: "image", url: "https://cdn/x.jpg" });
    expect(templatePreviewSource(tpl({ engine: "orshot", previewUrl: "https://cdn/o.png" }))).toEqual({ kind: "image", url: "https://cdn/o.png" });
    expect(templatePreviewSource(tpl({ engine: "orshot" }))).toEqual({ kind: "none" });
    expect(templatePreviewSource(tpl({ engine: "lyonix", externalTemplateId: "recipe:gone@9" }))).toEqual({ kind: "none" });
  });

  it("the motion tab is Creatomate-only, needs the public token and a supported browser", () => {
    const config = { configured: true, publicToken: "pub_1" };
    expect(canShowMotionPreview({ engine: "creatomate" }, config, true)).toBe(true);
    expect(canShowMotionPreview({ engine: "creatomate" }, config, false)).toBe(false);
    expect(canShowMotionPreview({ engine: "creatomate" }, { configured: false, publicToken: null }, true)).toBe(false);
    expect(canShowMotionPreview({ engine: "creatomate" }, null, true)).toBe(false);
    expect(canShowMotionPreview({ engine: "orshot" }, config, true)).toBe(false);
    expect(canShowMotionPreview({ engine: "lyonix" }, config, true)).toBe(false);
  });

  it("previous / next wrap around the list", () => {
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(1, 3, 1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});
