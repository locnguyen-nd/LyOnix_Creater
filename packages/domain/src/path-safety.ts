/**
 * Path-safety helpers so media/source services never accept a client-controlled
 * filesystem path. Server always derives the on-disk relative path from
 * IDs/checksums it owns; these guards defend that invariant.
 */

const TRAVERSAL_SEGMENT = /(^|\/|\\)\.\.(\/|\\|$)/;

/** True if `candidate` is a clean project-relative path with no traversal/absolute/drive component. */
export const isSafeRelativePath = (candidate: string): boolean => {
  if (!candidate || typeof candidate !== "string") return false;
  const normalized = candidate.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return false; // absolute posix path
  if (/^[a-zA-Z]:/.test(normalized)) return false; // windows drive path
  if (normalized.startsWith("~")) return false;
  if (TRAVERSAL_SEGMENT.test(normalized)) return false;
  if (normalized.includes("\0")) return false;
  return true;
};

/** Resolve `relativePath` under `rootAbsolutePath` and assert the result stays inside root. */
export const resolveWithinRoot = (
  rootAbsolutePath: string,
  relativePath: string,
  resolveFn: (...segments: string[]) => string,
  relativeFn: (from: string, to: string) => string,
): { ok: true; absolutePath: string } | { ok: false; reason: string } => {
  if (!isSafeRelativePath(relativePath)) return { ok: false, reason: "unsafe_relative_path" };
  const absolutePath = resolveFn(rootAbsolutePath, relativePath);
  const rel = relativeFn(rootAbsolutePath, absolutePath);
  if (rel.startsWith("..") || rel.split(/[\\/]/)[0] === "..") return { ok: false, reason: "escapes_root" };
  return { ok: true, absolutePath };
};

/** Folder/file names must not contain separators or traversal tokens. */
export const isSafeSegmentName = (name: string): boolean => {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  if (/[\\/\0]/.test(trimmed)) return false;
  return trimmed.length <= 200;
};
