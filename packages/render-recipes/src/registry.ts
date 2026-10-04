import { NEWS_RECAP_BROADCAST_TELOP_JP_V1 } from "./recipes/news-recap-broadcast-telop-jp.v1.js";
import { validateRecipe, type RenderRecipe } from "./schema.js";

/**
 * Released recipes, keyed `id@version`. A released recipe is immutable: a change ships as a new `version` (older versions stay so
 * already-pinned TemplateSnapshots keep rendering exactly the same). Every entry is validated when the registry is built, so an invalid
 * recipe fails at import time (tests/boot), never at render time.
 */
export class RecipeRegistry {
  private readonly byKey = new Map<string, RenderRecipe>();

  constructor(recipes: readonly RenderRecipe[]) {
    for (const recipe of recipes) {
      const validation = validateRecipe(recipe);
      if (!validation.ok) throw new Error(`recipe ${recipe?.id}@${recipe?.version} is invalid: ${validation.errors.join("; ")}`);
      const key = `${recipe.id}@${recipe.version}`;
      if (this.byKey.has(key)) throw new Error(`recipe ${key} is registered twice`);
      this.byKey.set(key, recipe);
    }
  }

  get(id: string, version: number): RenderRecipe | null {
    return this.byKey.get(`${id}@${version}`) ?? null;
  }

  /** Highest version of a recipe id, or null. */
  latest(id: string): RenderRecipe | null {
    let best: RenderRecipe | null = null;
    for (const recipe of this.byKey.values()) if (recipe.id === id && (!best || recipe.version > best.version)) best = recipe;
    return best;
  }

  list(): RenderRecipe[] {
    return [...this.byKey.values()];
  }
}

export const RELEASED_RECIPES: RenderRecipe[] = [NEWS_RECAP_BROADCAST_TELOP_JP_V1];
export const recipeRegistry = new RecipeRegistry(RELEASED_RECIPES);
