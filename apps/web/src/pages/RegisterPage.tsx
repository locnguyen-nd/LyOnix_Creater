import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import { LanguageButton } from "../components/LanguageButton";
import { Button, Field, PasswordInput, TextInput } from "../components/ui";
import { useSession } from "../session";

export function RegisterPage() {
  const { t } = useTranslation();
  const { me } = useSession();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to="/" replace />;
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-lyx-muted p-6">
      <LanguageButton />
      <main className="w-full max-w-md rounded-[4px] border border-lyx-border bg-lyx-elevated p-6 shadow-sm">
        <h1 className="text-center text-[20px] font-semibold">{t("login.registerTitle")}</h1>
        <p className="mb-6 mt-2 text-center text-[14px] text-lyx-fg-muted">{t("tagline")}</p>
        {submitted ? (
          <div role="status" className="flex flex-col gap-4 text-center">
            <h2 className="text-[17px] font-semibold">{t("login.pendingTitle")}</h2>
            <p className="text-[14px] leading-6 text-lyx-fg-muted">{t("login.pendingMessage")}</p>
            <Link className="font-semibold text-lyx-primary underline-offset-4 hover:underline" to="/login">{t("login.backLogin")}</Link>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            if (password !== confirmation) { setError(t("login.passwordMismatch")); return; }
            setBusy(true);
            try {
              await api("/auth/register", { method: "POST", body: JSON.stringify({ displayName, email, password }) });
              setSubmitted(true);
            } catch (cause) {
              setError(cause instanceof ApiError && cause.code === "ACCOUNT_EMAIL_TAKEN" ? t("login.emailTaken") : cause instanceof ApiError && cause.code === "VALIDATION_FAILED" ? t("login.registrationInvalid") : cause instanceof ApiError && cause.code === "AUTH_RATE_LIMITED" ? t("login.rateLimited") : cause instanceof ApiError ? cause.message : t("common.error"));
            } finally { setBusy(false); }
          }}>
            <Field label={t("login.displayName")}><TextInput required autoComplete="name" maxLength={100} value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
            <Field label={t("login.email")}><TextInput required type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
            <Field label={t("login.password")} hint={t("login.passwordHint")}><PasswordInput required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
            <Field label={t("login.confirmPassword")}><PasswordInput required minLength={8} maxLength={128} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
            {error ? <p role="alert" className="text-[12px] text-lyx-danger">{error}</p> : null}
            <Button type="submit" disabled={busy}>{busy ? t("common.loading") : t("login.createAccount")}</Button>
            <p className="text-center text-[13px] text-lyx-fg-muted"><Link className="font-semibold text-lyx-primary underline-offset-4 hover:underline" to="/login">{t("login.hasAccount")}</Link></p>
          </form>
        )}
      </main>
    </div>
  );
}
