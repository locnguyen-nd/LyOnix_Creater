/**
 * V04-XX: what a template preview shows - pure, no DOM, no network.
 *  - Creatomate / Orshot: the provider's own preview image (its CDN; no render, no credit); Creatomate can also play the template
 *    live in the browser with the Preview SDK (optional tab, needs the public token, desktop only, no render job);
 *  - LyOnix (internal engine): there is no image, so the recipe itself is drawn as a simulation (layout, colours, caption style).
 * Previewing never selects, pins or renders anything: only the explicit "choose" action does.
 */
import { recipeRegistry, type RenderRecipe } from "@lyonix/render-recipes";
import type { CreatomateTemplateSummaryResponse, RenderEngine } from "@lyonix/contracts";

export type PreviewableTemplate = Pick<CreatomateTemplateSummaryResponse, "externalTemplateId" | "name" | "previewUrl" | "tags"> & { engine: RenderEngine };

export type TemplatePreviewSource =
  | { kind: "recipe"; recipe: RenderRecipe }
  | { kind: "image"; url: string }
  | { kind: "none" };

/** `recipe:<id>@<version>` (the internal engine's template id, see render-engine-store.service.ts) -> the released recipe, or null. */
export function recipeFromExternalId(externalTemplateId: string): RenderRecipe | null {
  const match = /^recipe:(.+)@(\d+)$/.exec(externalTemplateId);
  return match ? recipeRegistry.get(match[1]!, Number(match[2])) : null;
}

export function templatePreviewSource(template: PreviewableTemplate): TemplatePreviewSource {
  if (template.engine === "lyonix") {
    const recipe = recipeFromExternalId(template.externalTemplateId);
    if (recipe) return { kind: "recipe", recipe };
  }
  return template.previewUrl ? { kind: "image", url: template.previewUrl } : { kind: "none" };
}

/** The live "motion" tab: Creatomate templates only, when the server has a Preview SDK public token and the browser can run the SDK. */
export const canShowMotionPreview = (template: Pick<PreviewableTemplate, "engine">, config: { configured: boolean; publicToken: string | null } | null, supported: boolean): boolean =>
  template.engine === "creatomate" && Boolean(config?.configured && config.publicToken) && supported;

/** Previous / next template in the list (wraps around). */
export const stepIndex = (index: number, length: number, delta: -1 | 1): number => (length <= 0 ? 0 : (index + delta + length) % length);
