/**
 * Shared invariant: once a version is approved/pinned it is immutable. Any
 * edit must create a new version row instead of mutating the approved one,
 * and any consumer that pinned the old version keeps working against it.
 */

export type VersionedRecord = { approvedAt: Date | string | null | undefined };

export const isApproved = (record: VersionedRecord): boolean => Boolean(record.approvedAt);

export type ImmutabilityCheck = { ok: true } | { ok: false; reason: "already_approved" };

/** Call before an in-place UPDATE on a version row; approved versions must fork instead. */
export const assertMutable = (record: VersionedRecord): ImmutabilityCheck =>
  isApproved(record) ? { ok: false, reason: "already_approved" } : { ok: true };

export const nextVersionNumber = (currentMax: number | null | undefined): number => (currentMax ?? 0) + 1;
