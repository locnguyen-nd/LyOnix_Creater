/** Numbered Orshot pages use one scene per page, with media/subtitle/tag on that page. */
export function orshotPageCount(slots: readonly { key: string; kind: string }[]): number | null {
  const mediaPages = slots.filter((slot) => /^page[1-9]\d*@media$/.test(slot.key) && (slot.kind === "video" || slot.kind === "image"))
    .map((slot) => Number(/^page(\d+)@/.exec(slot.key)![1]));
  if (mediaPages.length === 0) return null;
  const pages = new Set(mediaPages);
  if (pages.size !== mediaPages.length || Math.max(...pages) !== pages.size) return null;
  return pages.size;
}
