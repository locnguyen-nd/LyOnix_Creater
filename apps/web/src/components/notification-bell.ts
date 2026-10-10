import type { NotificationResponse } from "@lyonix/contracts";

/** VE2E-158: the bell's browser-notification opt-in and "what is new since the last poll" (pure / storage-guarded helpers). */

const OPT_IN_KEY = "lyx-browser-notify";

export function browserNotificationState(): "unsupported" | "denied" | "on" | "off" {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" ? "on" : "off";
}

/** The user's own choice (per browser); unreadable storage = off. */
export function readBrowserOptIn(): boolean {
  try {
    return window.localStorage.getItem(OPT_IN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeBrowserOptIn(on: boolean) {
  try {
    window.localStorage.setItem(OPT_IN_KEY, on ? "1" : "0");
  } catch {
    /* per-viewer convenience only */
  }
}

/** Unread notifications that were not in the previous list. The first load (`seen` null) pops nothing: old ones are not re-announced. */
export function freshUnread(items: readonly NotificationResponse[], seen: ReadonlySet<string> | null): NotificationResponse[] {
  if (seen === null) return [];
  return items.filter((item) => !item.readAt && !seen.has(item.id));
}
