/**
 * VE2E-13: the Creatomate JavaScript Preview SDK (`@creatomate/preview`, browser-side)
 * needs a project-scoped "public token" from the Creatomate dashboard — a *different*
 * credential from the server-held render API secret key (`ProviderAccount.encryptedSecret`)
 * that already powers every real `POST /v2/renders` call. Creatomate's own SDK docs name it
 * a "public token" because it is designed to be embedded client-side (it only grants
 * browser preview/editing capability, never a render or the account's real API key), so
 * this is deliberately a single environment-level config value — the same shape as
 * `PUBLIC_BASE_URL` in `media-delivery.service.ts` — rather than a new per-`ProviderAccount`
 * encrypted secret column, matching "current account is pinned" (VE2E-13's own task note:
 * no multi-account render failover exists yet, see VE2E-17).
 *
 * B10/B11 (secrets-in-manager, Creatomate SDK billing/entitlement confirmation) gate the
 * owner actually supplying this value — until then this reads `undefined`/empty and every
 * caller must fail closed to a clear "preview not configured" state, exactly like every
 * other `PROVIDER_NOT_CONFIGURED` gate in this codebase. Never a silent fallback to a fake
 * or billable action.
 */
export const creatomatePreviewPublicToken = (): string | null => {
  const raw = process.env.CREATOMATE_PREVIEW_PUBLIC_TOKEN?.trim();
  return raw ? raw : null;
};

export const creatomatePreviewConfigured = (): boolean => creatomatePreviewPublicToken() !== null;
