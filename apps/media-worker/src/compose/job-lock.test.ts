import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobLockBusyError } from "../job-errors.js";
import { acquireJobLock, lockOwner, lockOwnerGone } from "./job-lock.js";

describe("compose / clip job lock", () => {
  let dir: string;
  const now = () => new Date();
  const HOURS = 2 * 60 * 60_000;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lyonix-lock-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes <host> <pid> and releases", async () => {
    const release = await acquireJobLock(dir, "compose:a", HOURS, now);
    expect(await readFile(join(dir, ".lock"), "utf8")).toBe(lockOwner());
    expect(lockOwner()).toBe(`${hostname()} ${process.pid}`);
    await release();
    await expect(acquireJobLock(dir, "compose:a", HOURS, now)).resolves.toBeTypeOf("function");
  });

  it("a lock left by a worker that died on this host is taken over at once (no 2 h wait -> no FFMPEG_TIMEOUT on the re-delivery)", async () => {
    await writeFile(join(dir, ".lock"), `${hostname()} 14000`);
    const release = await acquireJobLock(dir, "compose:b", HOURS, now, (pid) => pid !== 14000);
    expect(await readFile(join(dir, ".lock"), "utf8")).toBe(lockOwner());
    await release();
  });

  it("legacy pid-only locks (written before the host was recorded) are judged on this host too", async () => {
    await writeFile(join(dir, ".lock"), "14000");
    expect(await lockOwnerGone(join(dir, ".lock"), () => false)).toBe(true);
    expect(await lockOwnerGone(join(dir, ".lock"), () => true)).toBe(false);
  });

  it("a live owner, or a lock of another host, is busy until the stale window passes", async () => {
    await writeFile(join(dir, ".lock"), `${hostname()} 14000`);
    await expect(acquireJobLock(dir, "compose:c", HOURS, now, () => true)).rejects.toBeInstanceOf(JobLockBusyError);
    await writeFile(join(dir, ".lock"), "other-render-host 14000");
    await expect(acquireJobLock(dir, "compose:c", HOURS, now, () => false)).rejects.toBeInstanceOf(JobLockBusyError);
    const later = () => new Date(Date.now() + HOURS + 60_000);
    await expect(acquireJobLock(dir, "compose:c", HOURS, later, () => true)).resolves.toBeTypeOf("function");
  });

  it("this very process holding the lock is genuinely busy (a concurrent delivery in the same worker)", async () => {
    await writeFile(join(dir, ".lock"), lockOwner());
    expect(await lockOwnerGone(join(dir, ".lock"), () => false)).toBe(false);
  });
});
