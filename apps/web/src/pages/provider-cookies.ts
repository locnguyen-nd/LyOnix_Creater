/** VE2E-145: the platforms a `social_cookies` provider account can hold cookies for (same list as packages/domain social-cookies.ts). */
export const COOKIE_PLATFORMS = ["tiktok", "youtube", "pinterest", "x", "instagram"] as const;
export type CookiePlatform = (typeof COOKIE_PLATFORMS)[number];

const WARN_MS = 3 * 24 * 60 * 60_000;

/** Which i18n line the Providers card shows under a cookies account, and whether it is a warning (expires within 3 days or already expired). */
export const cookiesExpiryNote = (expiresAt: string | null, now: Date = new Date()): { key: string; date: string | null; soon: boolean } => {
  if (!expiresAt) return { key: "providers.cookiesSessionOnly", date: null, soon: false };
  const soon = new Date(expiresAt).getTime() - now.getTime() < WARN_MS;
  return { key: soon ? "providers.cookiesExpiringSoon" : "providers.cookiesExpires", date: expiresAt, soon };
};
