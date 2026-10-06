/** Numbered Orshot pages use one scene per page, with media/subtitle/tag on that page. */
export function orshotPageCount(slots: readonly { key: string; kind: string }[]): number | null {
  const mediaPages = slots.filter((slot) => /^page[1-9]\d*@media$/.test(slot.key) && (slot.kind === "video" || slot.kind === "image"))
    .map((slot) => Number(/^page(\d+)@/.exec(slot.key)![1]));
  if (mediaPages.length === 0) return null;
  const pages = new Set(mediaPages);
  if (pages.size !== mediaPages.length || Math.max(...pages) !== pages.size) return null;
  return pages.size;
}

/**
 * Which pages of a numbered Orshot template to render (`response.includePages`). A template with 10 pages and a script of 9 scenes
 * renders pages 1-9 only; the unused pages are simply not rendered. Returns `null` when every page is used (nothing to restrict), the
 * template is not a numbered-page template, or no page has an assignment.
 */
export function orshotIncludePages(slots: readonly { key: string; kind: string }[], assignmentKeys: readonly string[]): number[] | null {
  const total = orshotPageCount(slots);
  if (total === null) return null;
  const used = new Set<number>();
  for (const key of assignmentKeys) {
    const match = /^page([1-9]\d*)@/.exec(key);
    if (match) used.add(Number(match[1]));
  }
  if (used.size === 0) return null;
  const last = Math.min(total, Math.max(...used));
  return last >= total ? null : Array.from({ length: last }, (_, index) => index + 1);
}

/** Largest scene count an Orshot page template can carry (one scene per page), or null when it is not a numbered-page template. */
export const orshotMaxScenes = orshotPageCount;
