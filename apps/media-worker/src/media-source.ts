import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { resolveWithinRoot } from "@lyonix/domain";
import { MediaJobError } from "./job-errors.js";

/**
 * Resolves a job's `source.relativePath` to a real file strictly inside MEDIA_ROOT (shared by every job type):
 * no quarantined files, no `..`/absolute/symlink escapes, regular files only. Never trusts a client path.
 */
export async function resolveMediaSource(mediaRoot: string, relativePath: string): Promise<string> {
  if (relativePath.startsWith("_quarantine/")) throw new MediaJobError("SOURCE_UNSAFE_PATH", "quarantined files cannot be used as media sources");
  const resolved = resolveWithinRoot(mediaRoot, relativePath, resolve, relative);
  if (!resolved.ok) throw new MediaJobError("SOURCE_UNSAFE_PATH", `source path rejected (${resolved.reason})`);
  let real: string;
  let realRoot: string;
  try {
    real = await realpath(resolved.absolutePath);
    realRoot = await realpath(mediaRoot);
  } catch {
    throw new MediaJobError("SOURCE_NOT_FOUND", "source file does not exist under MEDIA_ROOT");
  }
  const rel = relative(realRoot, real);
  if (rel.startsWith("..") || rel.split(/[\\/]/)[0] === "..") throw new MediaJobError("SOURCE_UNSAFE_PATH", "source resolves outside MEDIA_ROOT");
  const info = await stat(real);
  if (!info.isFile()) throw new MediaJobError("SOURCE_NOT_FOUND", "source is not a regular file");
  return real;
}
