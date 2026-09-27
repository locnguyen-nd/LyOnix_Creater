/**
 * VE2E-22: lists every Auto ("one-click") video-production run the caller themselves
 * created, across all of their self-provisioned projects — `POST /video-productions` (VE2E-08)
 * provisions a brand-new throwaway `Project` per submit and never writes a legacy
 * `ProductionRequest` row, so a run had no way to be found again anywhere in the UI once its
 * one-time submit response/URL was gone. `GET /video-productions` itself (VideoProductionsService.list())
 * already exists on `dev` (merged 2026-09-26, PR#6) — this page is purely the missing UI/nav
 * entry point, read-only, no new paid provider calls.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Banner, EmptyState, PageHeader, StatusPill } from "../components/chrome";
import { DataTable } from "../components/DataTable";
import { ApiError } from "../api";
import type { VideoProductionListItemResponse, WorkflowRunStatus } from "@lyonix/contracts";
import { listVideoProductions } from "../video-productions-api";

function statusTone(status: WorkflowRunStatus) {
  if (status === "completed") return "ok" as const;
  if (status === "failed" || status === "cancelled") return "danger" as const;
  if (status === "blocked_provider" || status === "needs_input") return "warn" as const;
  return "neutral" as const;
}

function formatDuration(ms: number | null) {
  if (!ms) return "—";
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatCost(row: VideoProductionListItemResponse) {
  return row.costAmount ?? "—";
}

export function VideoProductionsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [rows, setRows] = useState<VideoProductionListItemResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void listVideoProductions()
      .then(setRows)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")))
      .finally(() => setLoading(false));
  }, [t]);

  return (
    <>
      <PageHeader title={t("videoProductions.title")} breadcrumb={t("videoProductions.subtitle")} />
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {loading ? <p className="text-[12px] text-lyx-fg-muted">{t("common.loading")}</p> : null}
      {!loading ? (
        <DataTable
          rows={rows}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(`/video-productions/${row.id}`)}
          empty={<EmptyState title={t("videoProductions.empty")} />}
          columns={[
            {
              key: "thumbnail",
              header: t("videoProductions.thumbnail"),
              render: (row) => (
                <div className="flex h-14 w-9 items-center justify-center overflow-hidden rounded-[4px] bg-lyx-muted text-[8px] text-lyx-fg-subtle">
                  {row.snapshotUrl ? <img src={row.snapshotUrl} alt="" className="h-full w-full object-cover" /> : "9:16"}
                </div>
              ),
            },
            { key: "id", header: t("videoProductions.id"), render: (row) => <span className="font-mono text-[11px]">{row.id.slice(0, 8)}…</span> },
            { key: "status", header: t("videoProductions.status"), render: (row) => <StatusPill tone={statusTone(row.status)}>{t(`videoProduction.status.${row.status}`)}</StatusPill> },
            { key: "duration", header: t("videoProductions.duration"), render: (row) => (row.status === "completed" ? formatDuration(row.renderDurationMs) : "—") },
            { key: "cost", header: t("videoProductions.cost"), render: (row) => (row.status === "completed" ? formatCost(row) : "—") },
            { key: "createdAt", header: t("videoProductions.createdAt"), render: (row) => new Date(row.createdAt).toLocaleString() },
          ]}
        />
      ) : null}
    </>
  );
}
