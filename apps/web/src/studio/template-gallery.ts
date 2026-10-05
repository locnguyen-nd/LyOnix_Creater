import type { CreatomateTemplateSummaryResponse, RenderEngine } from "@lyonix/contracts";
import type { ApiProvider } from "../jobs-api";
import { engineOfProvider } from "./render-engine";

/** One card of the unified template gallery: a template of one render account, labelled with that account's engine. */
export type TemplateEntry = { key: string; accountId: string; accountName: string; engine: RenderEngine; template: CreatomateTemplateSummaryResponse };

/** Engine order of the gallery: internal templates first (the default engine), then the providers. */
const ENGINE_ORDER: Record<RenderEngine, number> = { lyonix: 0, creatomate: 1, orshot: 2 };

/** Merges the template lists of several render accounts (same index = same account) into one list, internal engine first, then by name. */
export function mergeTemplateEntries(accounts: ReadonlyArray<Pick<ApiProvider, "id" | "name" | "provider">>, lists: ReadonlyArray<ReadonlyArray<CreatomateTemplateSummaryResponse>>): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  accounts.forEach((account, index) => {
    for (const template of lists[index] ?? []) {
      entries.push({ key: `${account.id}:${template.externalTemplateId}`, accountId: account.id, accountName: account.name, engine: engineOfProvider(account.provider), template });
    }
  });
  return entries.sort((a, b) => ENGINE_ORDER[a.engine] - ENGINE_ORDER[b.engine] || a.template.name.localeCompare(b.template.name));
}
