import { Cog, Server, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { PageHeader, StatusPill } from "../components/chrome";
import { Button, Field, TextInput } from "../components/ui";
import { ProvidersPage } from "./ProvidersPage";
import { api } from "../api";
import type { ApiJob, ApiProvider } from "../jobs-api";
import { useMe, useSession } from "../session";
import { updateOrgSettings } from "../studio/store";

type Tab = "general" | "providers" | "operations";

export function SettingsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const { state, updateState } = useSession();
  const [tab, setTab] = useState<Tab>("general");
  const [timezone, setTimezone] = useState(state.orgTimezone);
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [providers, setProviders] = useState<ApiProvider[]>([]);

  useEffect(() => {
    void api<ApiJob[]>("/jobs").then(setJobs).catch(() => undefined);
    if (me.role === "admin") void api<ApiProvider[]>("/provider-accounts").then(setProviders).catch(() => undefined);
  }, []);

  const tabs: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
    { id: "general", label: t("org.settingsTabGeneral"), icon: Cog },
    { id: "providers", label: t("providers.title"), icon: SlidersHorizontal },
    { id: "operations", label: t("org.settingsTabOps"), icon: Server },
  ];

  return (
    <>
      <PageHeader title={t("nav.settings")} breadcrumb={t("org.settingsSubtitle")} />
      <div className="flex gap-6">
        <aside className="w-[220px] shrink-0">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex h-9 w-full items-center gap-2.5 rounded-[var(--lyx-radius)] px-2.5 text-[13px] font-medium ${tab === item.id ? "bg-lyx-muted font-semibold text-lyx-fg" : "text-lyx-fg-muted hover:text-lyx-fg"}`}
            >
              <item.icon size={16} strokeWidth={1.9} aria-hidden />
              {item.label}
            </button>
          ))}
        </aside>
        <div className="min-w-0 flex-1">

      {tab === "general" ? (
        <div className="flex flex-col gap-6 max-w-xl">
          <section>
            <h2 className="mb-3 text-[16px] font-semibold">{t("org.settings")}</h2>
            <Field label={t("org.timezone")}>
              <TextInput
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={me.role !== "admin"}
              />
            </Field>
            <p className="mt-2 mb-3 text-[12px] text-lyx-fg-muted">{t("org.retention")}</p>
            {me.role === "admin" ? (
              <Button onClick={() => updateState((prev) => updateOrgSettings(prev, me, timezone))}>
                {t("common.save")}
              </Button>
            ) : null}
          </section>
          {me.role === "admin" ? (
            <section className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4">
              <h2 className="mb-1 text-[14px] font-semibold">{t("org.people")}</h2>
              <p className="mb-3 text-[12px] text-lyx-fg-muted">{t("org.peopleHint")}</p>
              <Link to="/people"><Button variant="secondary">{t("org.people")} →</Button></Link>
            </section>
          ) : null}
        </div>
      ) : null}

      {tab === "providers" ? <ProvidersPage embedded /> : null}

      {tab === "operations" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4">
            <h3 className="mb-3 text-[14px] font-semibold">{t("org.opsJobs")}</h3>
            <div className="flex flex-col gap-2 text-[12.5px]">
              <div className="flex justify-between"><span>{t("org.opsJobsTotal")}</span><span className="font-semibold">{jobs.length}</span></div>
              <div className="flex justify-between"><span>{t("home.bucket.producing")}</span><span className="font-semibold">{jobs.filter((j) => ["producing", "editing", "rendering_vrew", "verifying"].includes(j.status)).length}</span></div>
              <div className="flex justify-between"><span>{t("home.bucket.review")}</span><span className="font-semibold">{jobs.filter((j) => j.status === "awaiting_staff_ack").length}</span></div>
              <div className="flex justify-between"><span>{t("home.bucket.done")}</span><span className="font-semibold">{jobs.filter((j) => ["completed", "handoff_workspace_ready"].includes(j.status)).length}</span></div>
              <div className="flex justify-between"><span>{t("home.bucket.blocked")}</span><span className="font-semibold text-lyx-danger">{jobs.filter((j) => ["blocked_provider", "needs_attention", "failed"].includes(j.status)).length}</span></div>
            </div>
            <Link to="/jobs" className="mt-3 inline-block text-[12px] font-semibold underline">{t("nav.jobs")} →</Link>
          </div>
          <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4">
            <h3 className="mb-3 text-[14px] font-semibold">{t("org.opsProviders")}</h3>
            {providers.length === 0 ? (
              <p className="text-[12px] text-lyx-fg-muted">{t("common.empty")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {providers.map((p) => (
                  <div key={p.id} className="flex items-center justify-between text-[12.5px]">
                    <span>{p.name}</span>
                    <StatusPill tone={p.status === "verified" ? "ok" : p.status === "failed" ? "danger" : "neutral"}>{t(`providers.${p.status}`)}</StatusPill>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={() => setTab("providers")} className="mt-3 text-[12px] font-semibold underline">{t("providers.title")} →</button>
          </div>
          <div className="rounded-[6px] border border-lyx-border bg-lyx-bg p-4 md:col-span-2">
            <h3 className="mb-1 text-[14px] font-semibold">{t("org.opsStorage")}</h3>
            <p className="text-[12px] text-lyx-fg-muted">{t("org.retention")}</p>
          </div>
        </div>
      ) : null}
        </div>
      </div>
    </>
  );
}
