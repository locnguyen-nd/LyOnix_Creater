import type { LucideIcon } from "lucide-react";
import {
  Clapperboard,
  Folder,
  LayoutDashboard,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
  Tv,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import i18n, { persistLocale } from "../i18n";
import { useMe, useSession } from "../session";
import { applyTheme, readTheme } from "../theme";
import type { ThemePref } from "../studio/types";
import { ChannelAvatar } from "./chrome";
import { Select } from "./ui";

const iconProps = { size: 17, strokeWidth: 1.9 } as const;

function Item({
  to,
  icon: Icon,
  label,
  collapsed,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  collapsed?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `flex h-9 items-center gap-2.5 rounded-[var(--lyx-radius)] px-2.5 text-[13px] font-medium ${collapsed ? "justify-center" : ""} ${isActive ? "bg-lyx-muted text-lyx-fg font-semibold" : "text-lyx-fg-muted hover:text-lyx-fg"}`
      }
    >
      <Icon {...iconProps} aria-hidden />
      {collapsed ? null : <span>{label}</span>}
    </NavLink>
  );
}

const NAV_COLLAPSE_KEY = "lyx-nav-collapsed";

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const { logout } = useSession();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<ThemePref>(readTheme);
  const [q, setQ] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(() => (typeof localStorage === "undefined" ? false : localStorage.getItem(NAV_COLLAPSE_KEY) === "1"));
  const isAdmin = me.role === "admin";
  const sidebarWidth = navCollapsed ? "72px" : "var(--lyx-sidebar)";

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const toggleNav = () => {
    setNavCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(NAV_COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-lyx-muted text-lyx-fg" style={{ "--lyx-sidebar-current": sidebarWidth } as React.CSSProperties}>
      <aside
        className={`fixed inset-y-0 left-0 z-20 flex w-[var(--lyx-sidebar-current)] flex-col gap-0.5 overflow-auto border-r border-lyx-border bg-lyx-bg py-5 transition-[width] duration-150 ${navCollapsed ? "px-2" : "px-3.5"}`}
      >
        <div className={`mb-5 flex items-center gap-2 text-[15px] font-bold tracking-tight ${navCollapsed ? "justify-center px-0" : "px-1.5"}`}>
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-lyx-fg text-[12px] font-extrabold text-lyx-bg">
            {t("brand").slice(0, 2).toUpperCase()}
          </span>
          {navCollapsed ? null : t("brand")}
        </div>
        {navCollapsed ? null : <p className="mb-1.5 px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">{t("nav.groupWorkspace")}</p>}
        <Item to="/" icon={LayoutDashboard} label={t("nav.dashboard")} collapsed={navCollapsed} />
        <Item to="/channels" icon={Tv} label={t("nav.channels")} collapsed={navCollapsed} />
        <Item to="/jobs" icon={Clapperboard} label={t("nav.jobs")} collapsed={navCollapsed} />
        <Item to="/assets" icon={Folder} label={t("nav.assets")} collapsed={navCollapsed} />
        {navCollapsed ? <div className="my-2 h-px bg-lyx-border" /> : <p className="mb-1.5 mt-4 px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">{t("nav.groupSystem")}</p>}
        <Item to="/settings" icon={Settings} label={t("nav.settings")} collapsed={navCollapsed} />
        {isAdmin ? <Item to="/people" icon={Users} label={t("nav.people")} collapsed={navCollapsed} /> : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggleNav}
          title={t(navCollapsed ? "nav.expand" : "nav.collapse")}
          aria-label={t(navCollapsed ? "nav.expand" : "nav.collapse")}
          className={`flex h-9 items-center gap-2.5 rounded-[var(--lyx-radius)] px-2.5 text-[13px] font-medium text-lyx-fg-muted hover:text-lyx-fg ${navCollapsed ? "justify-center" : ""}`}
        >
          {navCollapsed ? <PanelLeftOpen {...iconProps} aria-hidden /> : <PanelLeftClose {...iconProps} aria-hidden />}
          {navCollapsed ? null : t("nav.collapse")}
        </button>
        <button
          type="button"
          onClick={() => { void logout().finally(() => navigate("/login")); }}
          title={navCollapsed ? t("topbar.logout") : undefined}
          className={`flex h-9 items-center gap-2.5 rounded-[var(--lyx-radius)] px-2.5 text-[13px] font-medium text-lyx-fg-muted hover:text-lyx-fg ${navCollapsed ? "justify-center" : ""}`}
        >
          <LogOut {...iconProps} aria-hidden />
          {navCollapsed ? null : t("topbar.logout")}
        </button>
      </aside>
      <header className="fixed inset-x-0 top-0 z-10 flex h-[var(--lyx-topbar)] items-center justify-between gap-3 border-b border-lyx-border bg-lyx-bg pl-[calc(var(--lyx-sidebar-current)+24px)] pr-6 transition-[padding] duration-150">
        <form
          className="flex h-9 min-w-[260px] items-center gap-2 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-muted px-3 text-[12.5px] text-lyx-fg-muted"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(`/jobs?q=${encodeURIComponent(q)}`);
          }}
        >
          <Search size={14} strokeWidth={2} aria-hidden />
          <input
            className="w-full bg-transparent text-lyx-fg outline-none placeholder:text-lyx-fg-subtle"
            placeholder={t("topbar.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={t("topbar.search")}
          />
        </form>
        <div className="flex items-center gap-2">
          <Select
            aria-label={t("login.locale")}
            value={i18n.language}
            onChange={(e) => {
              const lng = e.target.value as "vi" | "en" | "ja" | "ko";
              void i18n.changeLanguage(lng);
              persistLocale(lng);
            }}
          >
            <option value="vi">VI</option>
            <option value="en">EN</option>
            <option value="ja">JA</option>
            <option value="ko">KO</option>
          </Select>
          <button
            type="button"
            className="lyx-btn lyx-btn-ghost h-9 w-9 !px-0"
            aria-label={t("topbar.theme")}
            onClick={() => setTheme((prev) => (prev === "dark" ? "light" : prev === "light" ? "system" : "dark"))}
          >
            {theme === "light" ? <Sun {...iconProps} /> : <Moon {...iconProps} />}
          </button>
          <button
            type="button"
            onClick={() => navigate("/me")}
            className="flex items-center gap-2 rounded-[var(--lyx-radius)] pl-1 pr-1.5 py-0.5 text-[12.5px] font-medium hover:bg-lyx-muted"
            title={t("nav.account")}
            aria-label={t("nav.account")}
          >
            <ChannelAvatar name={me.displayName} size={28} />
            <span className="hidden sm:inline">{me.displayName}</span>
          </button>
        </div>
      </header>
      <main className="ml-[var(--lyx-sidebar-current)] pt-[var(--lyx-topbar)] transition-[margin] duration-150">
        <div className="p-7">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
