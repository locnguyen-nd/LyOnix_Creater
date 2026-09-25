import type { LucideIcon } from "lucide-react";
import {
  Clapperboard,
  Folder,
  Globe,
  LayoutDashboard,
  LogOut,
  Moon,
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
}: {
  to: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `flex h-9 items-center gap-2.5 rounded-[var(--lyx-radius)] px-2.5 text-[13px] font-medium ${isActive ? "bg-lyx-muted text-lyx-fg font-semibold" : "text-lyx-fg-muted hover:text-lyx-fg"}`
      }
    >
      <Icon {...iconProps} aria-hidden />
      <span>{label}</span>
    </NavLink>
  );
}

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const { logout } = useSession();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<ThemePref>(readTheme);
  const [q, setQ] = useState("");
  const isAdmin = me.role === "admin";

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return (
    <div className="min-h-screen bg-lyx-muted text-lyx-fg">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-[var(--lyx-sidebar)] flex-col gap-0.5 overflow-auto border-r border-lyx-border bg-lyx-bg px-3.5 py-5">
        <div className="mb-5 flex items-center gap-2 px-1.5 text-[15px] font-bold tracking-tight">
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-lyx-fg text-[12px] font-extrabold text-lyx-bg">
            {t("brand").slice(0, 2).toUpperCase()}
          </span>
          {t("brand")}
        </div>
        <p className="mb-1.5 px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">{t("nav.groupWorkspace")}</p>
        <Item to="/" icon={LayoutDashboard} label={t("nav.dashboard")} />
        <Item to="/channels" icon={Tv} label={t("nav.channels")} />
        <Item to="/jobs" icon={Clapperboard} label={t("nav.jobs")} />
        <Item to="/assets" icon={Folder} label={t("nav.assets")} />
        <p className="mb-1.5 mt-4 px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">{t("nav.groupSystem")}</p>
        <Item to="/settings" icon={Settings} label={t("nav.settings")} />
        {isAdmin ? <Item to="/people" icon={Users} label={t("nav.people")} /> : null}
        <Item to="/me" icon={Globe} label={t("nav.account")} />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => { void logout().finally(() => navigate("/login")); }}
          className="flex h-9 items-center gap-2.5 rounded-[var(--lyx-radius)] px-2.5 text-[13px] font-medium text-lyx-fg-muted hover:text-lyx-fg"
        >
          <LogOut {...iconProps} aria-hidden />
          {t("topbar.logout")}
        </button>
      </aside>
      <header className="fixed inset-x-0 top-0 z-10 flex h-[var(--lyx-topbar)] items-center justify-between gap-3 border-b border-lyx-border bg-lyx-bg pl-[calc(var(--lyx-sidebar)+24px)] pr-6">
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
          <div className="flex items-center gap-2 pl-1 text-[12.5px] font-medium">
            <ChannelAvatar name={me.displayName} size={28} />
            <span className="hidden sm:inline">{me.displayName}</span>
          </div>
        </div>
      </header>
      <main className="ml-[var(--lyx-sidebar)] pt-[var(--lyx-topbar)]">
        <div className="p-7">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
