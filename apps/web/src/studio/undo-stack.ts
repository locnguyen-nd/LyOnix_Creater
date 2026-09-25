/**
 * VE2E-07 spec §7: "undo/redo local command stack" - kept intentionally simple
 * (snapshot-based, not a generic command/diff pattern) per the task's own scope note
 * ("không cần phức tạp, local command stack đơn giản là đủ"). Each call to `push`
 * records the state *before* a change is applied, so `undo` can restore it.
 */
export class UndoStack<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly limit = 50) {}

  /** Call with the state *before* applying a new change. */
  push(previous: T) {
    this.past.push(previous);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  canUndo() {
    return this.past.length > 0;
  }

  canRedo() {
    return this.future.length > 0;
  }

  /** Returns the state to restore, pushing `current` onto the redo stack. */
  undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(current);
    return previous;
  }

  /** Returns the state to restore, pushing `current` back onto the undo stack. */
  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  reset() {
    this.past = [];
    this.future = [];
  }
}
