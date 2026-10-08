import type { ApiProvider } from "../jobs-api";

/** Render providers a `render` account can belong to (Orshot = cost-optimised second option next to Creatomate). */
export const renderProviderLabel = (provider: string) => (provider === "lyonix" ? "LyOnix" : provider === "orshot" ? "Orshot" : "Creatomate");

/** The internal FFmpeg engine's system account (VE2E-111): read-only, no secret, templates come from the repo's recipes. */
export const isInternalRenderProvider = (provider: string | undefined) => provider === "lyonix";

/** "<account name> · Orshot" so the operator can tell the two render options apart in every account picker. */
export const renderAccountOptionLabel = (account: Pick<ApiProvider, "name" | "provider">) => (isInternalRenderProvider(account.provider) ? account.name : `${account.name} · ${renderProviderLabel(account.provider)}`);

/** Orshot only renders a saved template (fixed slots), never a fully dynamic N-scene composition. */
export const isTemplateOnlyRenderProvider = (provider: string | undefined) => provider === "orshot";

/**
 * VE2E-140: default render account of the Studio. Orshot is template-only (and many plans cannot render video), so it is offered last;
 * Creatomate (any template, dynamic composition) first, then the internal LyOnix engine.
 */
export const RENDER_DEFAULT_RANK: Record<string, number> = { creatomate: 0, lyonix: 1, orshot: 2 };
export const preferredRenderAccount = <T extends { provider: string }>(accounts: readonly T[]): T | undefined =>
  [...accounts].sort((a, b) => (RENDER_DEFAULT_RANK[a.provider] ?? 1) - (RENDER_DEFAULT_RANK[b.provider] ?? 1))[0];
