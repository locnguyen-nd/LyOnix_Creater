import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import type { NotificationResponse } from "@lyonix/contracts";
import { listNotifications, markAllNotificationsRead, markNotificationRead, unreadNotificationCount } from "../trend-radar-api";
import { browserNotificationState, freshUnread, readBrowserOptIn, writeBrowserOptIn } from "./notification-bell";

const POLL_MS = 60_000;

/**
 * VE2E-158 in-app notifications (the header bell): unread count polled every minute, the latest 30, open / mark read / mark all read.
 * A browser notification is shown only after the user turned it on here (and the browser allowed it) - never asked for on its own.
 */
export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationResponse[] | null>(null);
  const [browser, setBrowser] = useState(browserNotificationState);
  const seen = useRef<Set<string> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const list = await listNotifications();
    setItems(list.items);
    setUnread(list.unread);
    return list;
  }, []);

  // Count only (cheap); the list is fetched when the count grows (to pop a browser notification for the new ones) or the panel opens.
  const poll = useCallback(async () => {
    try {
      const { unread: count } = await unreadNotificationCount();
      setUnread(count);
      if (seen.current === null || count > 0) {
        const list = await load();
        const fresh = freshUnread(list.items, seen.current);
        seen.current = new Set(list.items.map((item) => item.id));
        if (fresh.length && browserNotificationState() === "on" && readBrowserOptIn()) {
          for (const item of fresh.slice(0, 3)) new Notification(item.title, { ...(item.body ? { body: item.body } : {}), tag: item.id });
        }
      }
    } catch {
      /* signed out or offline: the bell just keeps its last state */
    }
  }, [load]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [poll]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const openItem = async (item: NotificationResponse) => {
    if (!item.readAt) {
      setItems((current) => current?.map((entry) => (entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry)) ?? current);
      setUnread((count) => Math.max(0, count - 1));
      void markNotificationRead(item.id).catch(() => undefined);
    }
    setOpen(false);
    if (item.link) navigate(item.link);
  };

  const markAll = async () => {
    await markAllNotificationsRead().catch(() => undefined);
    await load().catch(() => undefined);
  };

  const enableBrowser = async () => {
    if (typeof Notification === "undefined") return;
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    writeBrowserOptIn(permission === "granted");
    setBrowser(browserNotificationState());
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        className="lyx-btn lyx-btn-ghost relative h-9 w-9 !px-0"
        aria-label={`${t("notifications.title")}${unread ? ` (${t("notifications.unread", { count: unread })})` : ""}`}
        aria-expanded={open}
        data-testid="notification-bell"
        onClick={() => { setOpen((prev) => !prev); if (!open) void load().catch(() => undefined); }}
      >
        <Bell size={17} strokeWidth={1.9} aria-hidden />
        {unread ? <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-lyx-danger px-1 text-[10px] font-bold leading-[18px] text-white">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div role="dialog" aria-label={t("notifications.title")} className="lyx-anim-modal absolute right-0 top-11 z-30 flex max-h-[70vh] w-[min(380px,calc(100vw-24px))] flex-col overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-elevated shadow-lg">
          <div className="flex items-center justify-between gap-2 border-b border-lyx-border px-3 py-2">
            <strong className="text-[13px]">{t("notifications.title")}</strong>
            <button type="button" className="text-[12px] text-lyx-fg-muted hover:text-lyx-fg disabled:opacity-50" disabled={!unread} onClick={() => void markAll()}>{t("notifications.markAll")}</button>
          </div>
          <ul className="flex-1 overflow-auto">
            {items === null ? <li className="px-3 py-4 text-[12.5px] text-lyx-fg-muted">{t("common.loading")}</li> : items.length === 0 ? <li className="px-3 py-4 text-[12.5px] text-lyx-fg-muted">{t("notifications.empty")}</li> : items.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => void openItem(item)} className={`flex w-full flex-col gap-0.5 border-b border-lyx-border px-3 py-2 text-left hover:bg-lyx-muted ${item.readAt ? "text-lyx-fg-muted" : ""}`}>
                  <span className="flex items-start gap-2 text-[12.5px] font-medium">
                    {item.readAt ? null : <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-lyx-danger" aria-hidden />}
                    <span lang="ja" className="min-w-0">{item.title}</span>
                  </span>
                  {item.body ? <span className="text-[11.5px] text-lyx-fg-muted">{item.body}</span> : null}
                  <span className="text-[10.5px] text-lyx-fg-subtle">{new Date(item.createdAt).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
          {browser === "unsupported" ? null : (
            <div className="border-t border-lyx-border px-3 py-2 text-[12px]">
              {browser === "on" && readBrowserOptIn() ? <span className="text-lyx-fg-muted">{t("notifications.browserOn")}</span>
                : browser === "denied" ? <span className="text-lyx-fg-muted">{t("notifications.browserDenied")}</span>
                : <button type="button" className="underline" onClick={() => void enableBrowser()}>{t("notifications.enableBrowser")}</button>}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
