/** FIFO counting semaphore: caps how many reframe analyses run detectors at once in this process (REFRAME_CONCURRENCY). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Semaphore limit must be an integer >= 1");
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active += 1;
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next(); // hand the slot straight to the next waiter
      else this.active -= 1;
    }
  }
}
