import type { ThemePref } from "./studio/types";

export const THEME_KEY = "lyx-theme";

export function readTheme(): ThemePref {
  const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export function isDark(pref: ThemePref): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(pref: ThemePref) {
  document.documentElement.classList.toggle("dark", isDark(pref));
  localStorage.setItem(THEME_KEY, pref);
}
