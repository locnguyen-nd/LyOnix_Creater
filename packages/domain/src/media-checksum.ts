export type ExistingAsset = { id: string; checksumSha256: string; reusable: boolean; deletedAt?: Date | string | null };

/**
 * Duplicate checksum policy: within a project, a reusable asset with the same
 * checksum is not re-imported — the existing row is returned so folders/scenes
 * can reference it instead of duplicating storage.
 */
export const findDuplicateReusableAsset = (
  candidateChecksum: string,
  existing: readonly ExistingAsset[],
): ExistingAsset | null =>
  existing.find((asset) => asset.reusable && !asset.deletedAt && asset.checksumSha256 === candidateChecksum) ?? null;

const HEX_64 = /^[0-9a-f]{64}$/i;
export const isSha256Hex = (value: string): boolean => HEX_64.test(value);
