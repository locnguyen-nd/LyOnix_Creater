/**
 * VE2E-124 (owner decision): ScriptPage keeps its existing versioning (each "Save" = a new ScriptVersion) - no second draft system.
 * These helpers only detect unsaved edits, so the page can warn before they are lost and save them before Approve / Revise.
 */

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

/** Do the on-screen script and the last saved one differ (key order ignored)? */
export const isScriptDirty = (current: unknown, saved: unknown): boolean => stable(current) !== stable(saved);

/**
 * Is this click a plain in-app navigation away from the current page (a link to another route of this app, same tab, no modifier)?
 * New-tab clicks, other origins and same-page hash links do not lose the edits, so they are not interrupted.
 */
export function isInAppNavigation(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">,
  anchor: Pick<HTMLAnchorElement, "href" | "target" | "hasAttribute">,
  location: Pick<Location, "origin" | "pathname" | "search">,
): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return false;
  let url: URL;
  try {
    url = new URL(anchor.href, location.origin);
  } catch {
    return false;
  }
  if (url.origin !== location.origin) return false;
  return url.pathname !== location.pathname || url.search !== location.search;
}
