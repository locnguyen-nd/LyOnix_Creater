import { useTranslation } from "react-i18next";
import i18n, { persistLocale } from "../i18n";

const localeLabels = { vi: "VI", en: "EN", ja: "JA", ko: "KO" } as const;

export function LanguageButton() {
  const { t } = useTranslation();
  const locale = (i18n.language in localeLabels ? i18n.language : "vi") as keyof typeof localeLabels;
  return (
    <label className="absolute right-4 top-4">
      <span className="sr-only">{t("login.language")}</span>
      <select
        aria-label={t("login.language")}
        value={locale}
        onChange={(event) => {
          const next = event.target.value as keyof typeof localeLabels;
          void i18n.changeLanguage(next);
          persistLocale(next);
        }}
        className="h-8 w-[58px] cursor-pointer appearance-none rounded-full border border-lyx-border bg-lyx-elevated px-2 text-center text-[11px] font-semibold text-lyx-fg"
      >
        {Object.entries(localeLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-lyx-fg-muted">⌄</span>
    </label>
  );
}
