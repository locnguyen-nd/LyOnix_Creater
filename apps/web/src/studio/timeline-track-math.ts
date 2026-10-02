/** Pure geometry/ordering helpers for the direct-manipulation scene track (see SceneTimelineTrack). */

/** Fraction (0..1) of the clip width at which each sentence boundary sits, proportional to cumulative text length. */
export function splitMarkerRatios(sentences: readonly string[]): number[] {
  const total = sentences.reduce((sum, sentence) => sum + Math.max(1, sentence.length), 0);
  if (sentences.length < 2 || total === 0) return [];
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < sentences.length - 1; i++) {
    acc += Math.max(1, sentences[i]!.length);
    out.push(acc / total);
  }
  return out;
}

/** Gap index (0..n) a dragged clip would be dropped into: the number of clips whose midpoint lies left of `x`. */
export function dropIndexFromPointer(x: number, offsets: readonly number[], widths: readonly number[]): number {
  let index = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (x > offsets[i]! + widths[i]! / 2) index = i + 1;
  }
  return index;
}

/** Returns a copy of `items` with the element at `from` moved to `to` (indices into the list as it is before the move). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
