import type { ApiProvider } from "../jobs-api";

/** Render providers a `render` account can belong to (Orshot = cost-optimised second option next to Creatomate). */
export const renderProviderLabel = (provider: string) => (provider === "orshot" ? "Orshot" : "Creatomate");

/** "<account name> · Orshot" so the operator can tell the two render options apart in every account picker. */
export const renderAccountOptionLabel = (account: Pick<ApiProvider, "name" | "provider">) => `${account.name} · ${renderProviderLabel(account.provider)}`;

/** Orshot only renders a saved template (fixed slots), never a fully dynamic N-scene composition. */
export const isTemplateOnlyRenderProvider = (provider: string | undefined) => provider === "orshot";
