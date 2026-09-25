import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { UiLocale } from "@lyonix/contracts";
import { locales } from "./locales";

const STORAGE = "lyx-locale";

export function readLocale(): UiLocale {
  const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE);
  if (raw === "vi" || raw === "en" || raw === "ja" || raw === "ko") return raw;
  return "vi";
}

export function persistLocale(locale: UiLocale) {
  localStorage.setItem(STORAGE, locale);
  document.documentElement.lang = locale;
}

void i18n.use(initReactI18next).init({
  lng: readLocale(),
  fallbackLng: "vi",
  interpolation: { escapeValue: false },
  resources: {
    vi: { translation: locales.vi },
    en: { translation: locales.en },
    ja: { translation: locales.ja },
    ko: { translation: locales.ko },
  },
});

export default i18n;
