export type RetentionClass = "project" | "working";

export const WORKING_RETENTION_DAYS = 7;

/**
 * `project` (reusable) assets never expire from this policy — only explicit
 * user delete or project archival removes them. `working` derivatives/cache
 * keep the standard 7-day TTL.
 */
export const computeExpiresAt = (retentionClass: RetentionClass, now: Date = new Date()): Date | null => {
  if (retentionClass === "project") return null;
  const expires = new Date(now.getTime());
  expires.setUTCDate(expires.getUTCDate() + WORKING_RETENTION_DAYS);
  return expires;
};

export const isExpired = (expiresAt: Date | null, now: Date = new Date()): boolean =>
  expiresAt !== null && expiresAt.getTime() <= now.getTime();

/** Reusable+project assets are exempt from TTL sweeps regardless of stored expiresAt. */
export const isRetentionExempt = (input: { retentionClass: RetentionClass; reusable: boolean }): boolean =>
  input.retentionClass === "project" && input.reusable;
