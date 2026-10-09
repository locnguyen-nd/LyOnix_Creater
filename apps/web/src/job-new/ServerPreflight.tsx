import { AlertTriangle, CheckCircle2, LoaderCircle, ShieldCheck, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AutoPreflightResponse, PreflightCheckResponse } from "@lyonix/contracts";

/**
 * Render reliability: the server-side Auto preflight on the create-video page (workers, render template, PUBLIC_BASE_URL, content
 * quota, voice, media). Only problems are listed, each with its fix; a blocking one disables the create button, a warning does not.
 */
export type ServerPreflightState =
  | { status: "idle" }
  | { status: "loading"; previous: AutoPreflightResponse | null }
  | { status: "ready"; result: AutoPreflightResponse }
  | { status: "failed" };

export const preflightResult = (state: ServerPreflightState): AutoPreflightResponse | null =>
  state.status === "ready" ? state.result : state.status === "loading" ? state.previous : null;

/** True when the server found something that would make the job fail: the create button stays disabled. */
export const serverPreflightBlocks = (state: ServerPreflightState): boolean =>
  Boolean(preflightResult(state)?.checks.some((check) => !check.ok && check.severity === "block"));

function CheckRow({ check }: { check: PreflightCheckResponse }) {
  const blocking = check.severity === "block";
  return (
    <li className={`flex gap-2 rounded-lg border px-2.5 py-2 text-[12px] leading-[17px] ${blocking ? "border-lyx-danger/40 bg-lyx-danger-bg" : "border-lyx-warn/40 bg-lyx-warn-bg"}`} data-testid={`preflight-${check.key}`}>
      <span className={`mt-px shrink-0 ${blocking ? "text-lyx-danger" : "text-lyx-warn"}`} aria-hidden="true">{blocking ? <XCircle size={14} strokeWidth={2} /> : <AlertTriangle size={14} strokeWidth={2} />}</span>
      <span className="min-w-0">
        <span className="block text-lyx-fg">{check.message}</span>
        {check.fix ? <span className="mt-0.5 block text-[11px] text-lyx-fg-muted">{check.fix}</span> : null}
      </span>
    </li>
  );
}

export function ServerPreflightPanel({ state }: { state: ServerPreflightState }) {
  const { t } = useTranslation();
  if (state.status === "idle") return null;
  const result = preflightResult(state);
  const problems = result ? result.checks.filter((check) => !check.ok).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1)) : [];
  return (
    <div className="flex flex-col gap-1.5" data-testid="server-preflight" aria-live="polite">
      <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-lyx-fg-subtle">
        <ShieldCheck size={12} strokeWidth={2.2} aria-hidden="true" />{t("jobs.serverPreflight.title")}
        {state.status === "loading" ? <LoaderCircle size={12} strokeWidth={2.2} className="animate-spin" aria-label={t("jobs.serverPreflight.checking")} /> : null}
      </p>
      {state.status === "failed" ? (
        <p className="text-[11.5px] text-lyx-fg-muted">{t("jobs.serverPreflight.unavailable")}</p>
      ) : !result ? (
        <p className="text-[11.5px] text-lyx-fg-muted">{t("jobs.serverPreflight.checking")}</p>
      ) : problems.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[12px] text-lyx-ok"><CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />{t("jobs.serverPreflight.allReady")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">{problems.map((check) => <CheckRow key={check.key} check={check} />)}</ul>
      )}
    </div>
  );
}
