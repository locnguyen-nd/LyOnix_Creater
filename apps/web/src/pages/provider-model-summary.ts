import type { ApiProvider } from "../jobs-api";

/** Count only models proven usable by a recent generate probe for this account. */
export function readyModelCount(row: ApiProvider): number {
  if (row.status !== "verified") return 0;
  const available = new Set(row.availableModels);
  const coolingDown = new Set(row.modelCooldowns?.map((item) => item.modelId) ?? []);
  return new Set(row.modelSnapshot
    ?.filter((item) => item.status === "usable" && item.fresh && available.has(item.modelId) && !coolingDown.has(item.modelId))
    .map((item) => item.modelId) ?? []).size;
}
