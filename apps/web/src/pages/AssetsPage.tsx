import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Banner, EmptyState, PageHeader } from "../components/chrome";
import { Modal } from "../components/Modal";
import { TextInput } from "../components/ui";
import { useMe, useSession } from "../session";
import { visibleJobs } from "../studio/store";
import type { AssetRow } from "../studio/types";

const KINDS = ["all", "video", "image", "audio", "file"] as const;

function FilterItem({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 w-full items-center justify-between rounded-[var(--lyx-radius)] px-2.5 text-[12.5px] font-medium ${active ? "bg-lyx-muted text-lyx-fg font-semibold" : "text-lyx-fg-muted hover:text-lyx-fg"}`}
    >
      <span className="truncate">{label}</span>
      <span className="text-[11px] text-lyx-fg-subtle">{count}</span>
    </button>
  );
}

export function AssetsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const { state } = useSession();
  const jobs = visibleJobs(state, me);
  const jobIds = new Set(jobs.map((j) => j.id));
  const all = state.assets.filter((a) => !a.jobId || jobIds.has(a.jobId));
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  const [jobId, setJobId] = useState<string>("all");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<AssetRow | null>(null);

  const byKind = useMemo(() => (kind === "all" ? all : all.filter((row) => row.kind === kind)), [all, kind]);
  const byJob = useMemo(() => (jobId === "all" ? byKind : byKind.filter((row) => row.jobId === jobId)), [byKind, jobId]);
  const rows = useMemo(
    () => (q.trim() ? byJob.filter((row) => row.name.toLowerCase().includes(q.trim().toLowerCase())) : byJob),
    [byJob, q],
  );

  const kindCounts = useMemo(() => {
    const map: Record<string, number> = { all: all.length };
    for (const row of all) map[row.kind] = (map[row.kind] ?? 0) + 1;
    return map;
  }, [all]);

  const jobGroups = useMemo(() => {
    const used = new Map<string, number>();
    for (const row of all) {
      if (!row.jobId) continue;
      used.set(row.jobId, (used.get(row.jobId) ?? 0) + 1);
    }
    return jobs.filter((job) => used.has(job.id)).map((job) => ({ job, count: used.get(job.id) ?? 0 }));
  }, [all, jobs]);

  return (
    <>
      <PageHeader title={t("assets.title")} breadcrumb={t("assets.subtitle", { count: all.length })} />

      <div className="flex gap-6">
        <aside className="w-[220px] shrink-0">
          <p className="mb-1.5 px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">{t("assets.byKind")}</p>
          <div className="flex flex-col gap-0.5">
            {KINDS.map((item) => (
              <FilterItem
                key={item}
                active={kind === item}
                label={t(item === "all" ? "jobs.all" : `assets.kinds.${item}`)}
                count={kindCounts[item] ?? 0}
                onClick={() => setKind(item)}
              />
            ))}
          </div>
          {jobGroups.length > 0 ? (
            <>
              <p className="mb-1.5 mt-4 px-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle">{t("assets.byProject")}</p>
              <div className="flex flex-col gap-0.5">
                <FilterItem active={jobId === "all"} label={t("assets.allProjects")} count={all.filter((r) => r.jobId).length} onClick={() => setJobId("all")} />
                {jobGroups.map(({ job, count }) => (
                  <FilterItem key={job.id} active={jobId === job.id} label={`${job.code} · ${job.topic}`} count={count} onClick={() => setJobId(job.id)} />
                ))}
              </div>
            </>
          ) : null}
          <div className="mt-4 rounded-[var(--lyx-radius)] border border-dashed border-lyx-border bg-lyx-muted p-3">
            <p className="text-[11.5px] font-semibold">{t("org.retention")}</p>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <Banner variant="warn">{t("assets.banner")}</Banner>
          <TextInput
            className="mb-4 w-full max-w-xs"
            placeholder={t("topbar.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {rows.length === 0 ? (
            <EmptyState title={t("common.empty")} />
          ) : (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="flex h-auto flex-col items-stretch overflow-hidden rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg p-0 text-left hover:border-lyx-fg"
                  onClick={() => setActive(row)}
                >
                  <div className="relative h-36 w-full bg-lyx-muted">
                    {row.kind === "video" ? (
                      <video className="h-full w-full object-cover" src={row.previewUrl} poster={row.thumbUrl} muted />
                    ) : row.kind === "image" ? (
                      <img className="h-full w-full object-cover" src={row.thumbUrl} alt="" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[11px] uppercase text-lyx-fg-subtle">
                        {t(`assets.kinds.${row.kind}`)}
                      </div>
                    )}
                    <span className="absolute left-2 top-2 rounded-[4px] bg-black/65 px-1.5 py-0.5 text-[10.5px] font-bold text-white">
                      {t(`assets.kinds.${row.kind}`)}
                    </span>
                  </div>
                  <span className="flex flex-col gap-0.5 px-2.5 py-2 text-[12px]">
                    <span className="truncate font-medium">{row.name}</span>
                    <span className="text-[11px] text-lyx-fg-muted">{row.sizeLabel}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {active ? (
        <Modal title={active.name} width={640} onClose={() => setActive(null)}>
          {active.kind === "video" && active.previewUrl ? (
            <video className="w-full" src={active.previewUrl} poster={active.thumbUrl} controls autoPlay />
          ) : active.kind === "image" ? (
            <img className="w-full" src={active.previewUrl || active.thumbUrl} alt={active.name} />
          ) : (
            <p className="text-lyx-fg-muted">{active.kind} · {active.sizeLabel}</p>
          )}
          <p className="mt-3 text-[12px] text-lyx-fg-muted">{t("assets.expiresAt")}: {active.expiresAt}</p>
        </Modal>
      ) : null}
    </>
  );
}
