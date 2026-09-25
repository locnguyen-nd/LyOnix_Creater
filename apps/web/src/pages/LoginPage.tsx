import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import i18n, { persistLocale } from "../i18n";
import { useSession } from "../session";
import { ApiError } from "../api";
import { Button, Field, PasswordInput, TextInput } from "../components/ui";
import { LanguageButton } from "../components/LanguageButton";
import { Link } from "react-router-dom";

export function LoginPage() {
  const { t } = useTranslation();
  const { me, login } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@lyonix.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (me) return <Navigate to="/" replace />;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-lyx-muted p-6">
      <LanguageButton />
      <form
        className="w-full max-w-sm rounded-[4px] border border-lyx-border bg-lyx-elevated p-6"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            const user = await login(email, password);
            void i18n.changeLanguage(user.preferences.uiLocale);
            persistLocale(user.preferences.uiLocale);
            navigate("/");
          } catch (err) {
            setError(err instanceof ApiError && err.code === "ACCOUNT_PENDING_APPROVAL" ? t("login.pendingLogin") : err instanceof ApiError && err.code === "AUTH_RATE_LIMITED" ? t("login.rateLimited") : err instanceof ApiError ? err.message : t("login.error"));
          }
        }}
      >
        <h1 className="text-center text-[20px] font-semibold">{t("brand")}</h1>
        <p className="mb-6 text-center text-[14px] text-lyx-fg-muted">{t("tagline")}</p>
        <div className="flex flex-col gap-4">
          <Field label={t("login.email")}>
            <TextInput
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              autoComplete="username"
            />
          </Field>
          <Field label={t("login.password")}>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error ? <p className="text-[12px] text-lyx-danger">{error}</p> : null}
          <Button type="submit">{t("login.submit")}</Button>
          <p className="text-center text-[13px] text-lyx-fg-muted">{t("login.noAccount")} <Link className="font-semibold text-lyx-primary underline-offset-4 hover:underline" to="/register">{t("login.register")}</Link></p>
        </div>
      </form>
    </div>
  );
}
