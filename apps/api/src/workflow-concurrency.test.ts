import { describe, expect, it } from "vitest";
import { fillWorkflowSlots, resolveWorkflowConcurrency } from "./workflow-concurrency.js";

describe("resolveWorkflowConcurrency", () => {
  it("defaults to 5 and clamps to 1..10", () => {
    expect(resolveWorkflowConcurrency({})).toBe(5);
    expect(resolveWorkflowConcurrency({ WORKFLOW_CONCURRENCY: "8" })).toBe(8);
    expect(resolveWorkflowConcurrency({ WORKFLOW_CONCURRENCY: "99" })).toBe(10);
    expect(resolveWorkflowConcurrency({ WORKFLOW_CONCURRENCY: "0" })).toBe(5);
    expect(resolveWorkflowConcurrency({ WORKFLOW_CONCURRENCY: "abc" })).toBe(5);
  });
});

describe("fillWorkflowSlots", () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

  it("starts runs up to the limit without waiting for any of them, then frees slots as they finish", async () => {
    const queue = Array.from({ length: 7 }, () => deferred());
    const inflight = new Set<Promise<void>>();
    let next = 0;
    const start = async () => (next < queue.length ? { done: queue[next++]!.promise } : null);

    expect(await fillWorkflowSlots(inflight, 5, start)).toBe(5);
    expect(inflight.size).toBe(5);
    expect(await fillWorkflowSlots(inflight, 5, start)).toBe(0); // full

    queue[0]!.resolve();
    queue[1]!.resolve();
    await Promise.race([...inflight]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await fillWorkflowSlots(inflight, 5, start)).toBe(2);
    expect(inflight.size).toBe(5);
  });

  it("stops filling when nothing is queued", async () => {
    const inflight = new Set<Promise<void>>();
    expect(await fillWorkflowSlots(inflight, 5, async () => null)).toBe(0);
  });
});
