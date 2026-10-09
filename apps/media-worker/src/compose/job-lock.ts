import { open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { JobLockBusyError } from "../job-errors.js";

const LOCK_FILE = ".lock";

/** What a lock file holds: `<host> <pid>` of the worker process that owns the job directory. */
export const lockOwner = (): string => `${hostname()} ${process.pid}`;

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
};

/**
 * Is the owner of this lock a worker process on THIS host that is no longer running (killed, crashed, machine slept)? Then the lock
 * can be taken over at once instead of after the time-based stale window (hours for a long compose), which used to make every
 * re-delivery of the same job bounce as "busy" until the API gave up (FFMPEG_TIMEOUT). A lock of another host is never judged here
 * (only the stale window applies to it). Legacy locks hold only a pid and were always written on the local host.
 */
export async function lockOwnerGone(lockPath: string, isAlive: (pid: number) => boolean = processAlive): Promise<boolean> {
  const text = (await readFile(lockPath, "utf8").catch(() => "")).trim();
  const withHost = /^(\S+) (\d+)$/.exec(text);
  const host = withHost ? withHost[1]! : /^\d+$/.test(text) ? hostname() : null;
  const pid = withHost ? Number(withHost[2]) : Number(text);
  if (host === null || host !== hostname() || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false; // this very process holds it (a concurrent delivery): genuinely busy
  return !isAlive(pid);
}

/**
 * Cross-process lock for one job directory (`open wx`), same protocol as `clip.prepare`: a lock whose owner process is gone (same host)
 * or that is older than `staleAfterMs` is taken over; a live one raises `JobLockBusyError` so the consumer requeues the delivery.
 */
export async function acquireJobLock(jobDir: string, jobKey: string, staleAfterMs: number, now: () => Date, isAlive?: (pid: number) => boolean): Promise<() => Promise<void>> {
  const lockPath = join(jobDir, LOCK_FILE);
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(lockOwner());
      await handle.close();
      return async () => {
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if ((info && now().getTime() - info.mtimeMs > staleAfterMs) || (await lockOwnerGone(lockPath, isAlive))) {
        await rm(lockPath, { force: true });
        continue;
      }
      throw new JobLockBusyError(jobKey);
    }
  }
  throw new JobLockBusyError(jobKey);
}
