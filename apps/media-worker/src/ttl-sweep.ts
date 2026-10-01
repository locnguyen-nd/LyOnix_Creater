import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { WORKING_RETENTION_DAYS } from "@lyonix/domain";
import { MEDIA_JOBS_DIR } from "./clip-prepare.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 7-day TTL for the media-worker's own working outputs (`MEDIA_ROOT/working/media-jobs`).
 * Deletes a job directory when its stored `expiresAt` has passed, or — for directories
 * without a manifest (failed/partial runs) — when untouched for WORKING_RETENTION_DAYS.
 * Never touches anything outside that directory (project assets are not swept here).
 */
export async function sweepExpiredMediaJobs(mediaRoot: string, now: Date = new Date()): Promise<{ removed: number }> {
  const root = join(mediaRoot, MEDIA_JOBS_DIR);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let expiresAtMs: number | null = null;
    try {
      const manifest = JSON.parse(await readFile(join(dir, "result.json"), "utf8")) as { result?: { output?: { expiresAt?: string }; expiresAt?: string } };
      const parsed = Date.parse(manifest.result?.output?.expiresAt ?? manifest.result?.expiresAt ?? "");
      expiresAtMs = Number.isFinite(parsed) ? parsed : null;
    } catch {
      expiresAtMs = null;
    }
    if (expiresAtMs === null) {
      const info = await stat(dir).catch(() => null);
      if (!info) continue;
      expiresAtMs = info.mtimeMs + WORKING_RETENTION_DAYS * DAY_MS;
    }
    if (expiresAtMs <= now.getTime()) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return { removed };
}
