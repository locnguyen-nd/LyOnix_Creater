import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiLocale } from "@lyonix/contracts";
import { Banner, PageHeader } from "../components/chrome";
import { Button, Field, PasswordInput, Select, TextInput } from "../components/ui";
import i18n, { persistLocale } from "../i18n";
import { useMe, useSession } from "../session";
import { SESSION_KEY, updatePreferences, updateProfile } from "../studio/store";
import { api, ApiError } from "../api";
import { applyTheme } from "../theme";
import type { ThemePref } from "../studio/types";

export function MePage() {
  const { t } = useTranslation();
  const me = useMe();
  const { state, updateState, loginAs } = useSession();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [theme, setTheme] = useState<ThemePref>(me.preferences.theme);
  const [locale, setLocale] = useState<UiLocale>(me.preferences.uiLocale);
  const [timezone, setTimezone] = useState(me.preferences.timezone);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  return (
    <>
      <PageHeader title={t("me.title")} />
      {message ? <Banner variant="info">{message}</Banner> : null}
      {error ? <Banner variant="danger">{error}</Banner> : null}
      <form
        className="mb-8 flex max-w-md flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const csrf = await api<{ csrfToken: string }>("/auth/csrf");
            const updated = await api<typeof me>("/me/preferences", { method: "PATCH", headers: { "x-csrf-token": csrf.csrfToken, "if-match": String(me.version) }, body: JSON.stringify({ theme, uiLocale: locale, timezone }) });
            const profile = updateProfile(state, me, { displayName, timezone });
            const prefs = updatePreferences(profile.state, { ...profile.me, ...updated }, { theme, uiLocale: locale, timezone });
            updateState(prefs.state); loginAs(prefs.me); applyTheme(theme);
            await i18n.changeLanguage(locale); persistLocale(locale); setMessage(t("me.saved")); setError(null);
          } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
        }}
      >
        <Field label={t("me.displayName")}>
          <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Email">
          <TextInput value={me.email} disabled />
        </Field>
        <Field label={t("org.timezone")}>
          <TextInput value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Field label={t("me.theme")}>
          <Select value={theme} onChange={(e) => setTheme(e.target.value as ThemePref)}>
            <option value="system">system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </Select>
        </Field>
        <Field label={t("me.locale")}>
          <Select value={locale} onChange={(e) => setLocale(e.target.value as UiLocale)}>
            <option value="vi">vi</option>
            <option value="en">en</option>
            <option value="ja">ja</option>
            <option value="ko">ko</option>
          </Select>
        </Field>
        <Button type="submit">{t("common.save")}</Button>
      </form>
      <form
        className="flex max-w-md flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (next.trim().length < 8) {
            setError(t("login.passwordHint"));
            return;
          }
          try {
            setPasswordBusy(true);
            setError(null);
            const csrf = await api<{ csrfToken: string }>("/auth/csrf");
            await api<void>("/me/change-password", {
              method: "POST",
              headers: { "x-csrf-token": csrf.csrfToken },
              body: JSON.stringify({ currentPassword: current, newPassword: next }),
            });
            // API revokes all sessions and clears auth cookies — hard navigate so local session state resets.
            sessionStorage.removeItem(SESSION_KEY);
            window.location.assign("/login");
          } catch (err) {
            setError(err instanceof ApiError ? err.message : t("common.error"));
          } finally {
            setPasswordBusy(false);
          }
        }}
      >
        <h2 className="text-[16px] font-semibold">{t("me.password")}</h2>
        <Field label={t("me.current")}>
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label={t("me.next")}>
          <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Button type="submit" disabled={passwordBusy || !current || !next}>
          {passwordBusy ? t("common.loading") : t("me.password")}
        </Button>
      </form>
    </>
  );
}
