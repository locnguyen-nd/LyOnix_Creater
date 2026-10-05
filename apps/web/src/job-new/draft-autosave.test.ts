import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_AUTOSAVE_DELAY_MS, DraftAutosaver, type DraftSaveStatus } from "./draft-autosave";

type Payload = { topic: string };

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("DraftAutosaver (VE2E-124)", () => {
  let statuses: DraftSaveStatus["kind"][];
  beforeEach(() => {
    vi.useFakeTimers();
    statuses = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (save: (payload: Payload, base: number | null) => Promise<{ version: number; updatedAt: string }>) =>
    new DraftAutosaver<Payload>({ save, onStatus: (s) => statuses.push(s.kind), isConflict: (e) => (e as { code?: string }).code === "VERSION_CONFLICT" });

  it("debounces: many quick changes -> one request with the last value, only after the delay", async () => {
    const save = vi.fn(async (_p: Payload, base: number | null) => ({ version: (base ?? 0) + 1, updatedAt: "2026-10-05T08:20:00Z" }));
    const saver = make(save);
    saver.start(null);
    saver.schedule({ topic: "M" });
    saver.schedule({ topic: "Me" });
    saver.schedule({ topic: "Messi" });
    await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_DELAY_MS - 100);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ topic: "Messi" }, null);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("never saves before start() (restore not finished), and stop() drops pending changes", async () => {
    const save = vi.fn(async () => ({ version: 1, updatedAt: "2026-10-05T08:20:00Z" }));
    const saver = make(save);
    saver.schedule({ topic: "initial defaults" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
    saver.start(3);
    saver.schedule({ topic: "typed" });
    saver.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
  });

  it("single flight: a change made during a save is sent after it, based on the version it returned (no out-of-order overwrite)", async () => {
    const first = deferred<{ version: number; updatedAt: string }>();
    const calls: Array<{ payload: Payload; base: number | null }> = [];
    const save = vi.fn((payload: Payload, base: number | null) => {
      calls.push({ payload, base });
      return calls.length === 1 ? first.promise : Promise.resolve({ version: 3, updatedAt: "2026-10-05T08:21:00Z" });
    });
    const saver = make(save);
    saver.start(1);
    saver.schedule({ topic: "older" });
    await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_DELAY_MS);
    saver.schedule({ topic: "newer" });
    await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_DELAY_MS);
    expect(calls).toHaveLength(1); // still waiting for the first request
    first.resolve({ version: 2, updatedAt: "2026-10-05T08:20:30Z" });
    await vi.runAllTimersAsync();
    expect(calls).toEqual([{ payload: { topic: "older" }, base: 1 }, { payload: { topic: "newer" }, base: 2 }]);
    expect(saver.currentVersion).toBe(3);
  });

  it("idle() waits for an in-flight save, so a delete after submit can never be undone by a late create", async () => {
    const first = deferred<{ version: number; updatedAt: string }>();
    const order: string[] = [];
    const saver = make(() => first.promise.then((r) => { order.push("save done"); return r; }));
    saver.start(null);
    saver.schedule({ topic: "typed just before submit" });
    await vi.advanceTimersByTimeAsync(DRAFT_AUTOSAVE_DELAY_MS);
    saver.stop();
    const deleting = saver.idle().then(() => order.push("delete"));
    first.resolve({ version: 1, updatedAt: "2026-10-05T08:20:00Z" });
    await deleting;
    expect(order).toEqual(["save done", "delete"]);
  });

  it("a failed save keeps the payload and retries it; a conflict pauses autosave until the user decides", async () => {
    let attempt = 0;
    const save = vi.fn(async (_p: Payload, base: number | null) => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      if (attempt === 2) throw Object.assign(new Error("conflict"), { code: "VERSION_CONFLICT" });
      return { version: (base ?? 0) + 1, updatedAt: "2026-10-05T08:22:00Z" };
    });
    const saver = make(save);
    saver.start(1);
    await saver.flush({ topic: "keep me" });
    expect(statuses.at(-1)).toBe("error");
    await saver.retry();
    expect(statuses.at(-1)).toBe("conflict");
    saver.schedule({ topic: "typing while in conflict" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(2); // paused: no silent overwrite
    saver.adoptVersion(7);
    await saver.retry();
    expect(save).toHaveBeenLastCalledWith({ topic: "typing while in conflict" }, 7);
    expect(statuses.at(-1)).toBe("saved");
  });
});
