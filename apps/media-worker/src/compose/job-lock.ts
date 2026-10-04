import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { JobLockBusyError } from "../job-errors.js";

const LOCK_FILE = ".lock";

/**
 * Cross-process lock for one job directory (`open wx`), same protocol as `clip.prepare`: a stale lock (older than `staleAfterMs`, e.g. a
 * crashed worker) is taken over, a live one raises `JobLockBusyError` so the consumer requeues the delivery.
 */
export async function acquireJobLock(jobDir: string, jobKey: string, staleAfterMs: number, now: () => Date): Promise<() => Promise<void>> {
  const lockPath = join(jobDir, LOCK_FILE);
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && now().getTime() - info.mtimeMs > staleAfterMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      throw new JobLockBusyError(jobKey);
    }
  }
  throw new JobLockBusyError(jobKey);
}
