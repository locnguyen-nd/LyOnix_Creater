import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader, Banner } from "../components/chrome";
import { Button, Select } from "../components/ui";
import { api, ApiError } from "../api";
import type { ApiProvider } from "../jobs-api";
import type { CreatomateTemplateSummaryResponse } from "@lyonix/contracts";
import { listCreatomateTemplates, pinTemplateSnapshot } from "../studio/timeline-api";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[6px] border px-3 py-1.5 text-left text-[12px] ${
        active ? "border-lyx-strong bg-lyx-muted font-medium text-lyx-fg" : "border-lyx-border text-lyx-fg-muted"
      }`}
    >
      {children}
    </button>
  );
}

export function TemplateGalleryPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [providerAccountId, setProviderAccountId] = useState("");
  const [templates, setTemplates] = useState<CreatomateTemplateSummaryResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);
  const [tag, setTag] = useState<string | "all">("all");

  useEffect(() => {
    void api<ApiProvider[]>("/provider-accounts").then((rows) => {
      setProviders(rows);
      const account = rows.find((row) => row.role === "render" && (row.isFake || row.status === "verified"));
      if (account) setProviderAccountId(account.id);
    });
  }, []);

  useEffect(() => {
    if (!providerAccountId) return;
    setLoading(true);
    setError(null);
    listCreatomateTemplates(providerAccountId)
      .then(setTemplates)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")))
      .finally(() => setLoading(false));
  }, [providerAccountId, t]);

  const tags = useMemo(() => [...new Set(templates.flatMap((tpl) => tpl.tags))], [templates]);
  const filtered = useMemo(() => (tag === "all" ? templates : templates.filter((tpl) => tpl.tags.includes(tag))), [templates, tag]);
  const renderAccounts = providers.filter((row) => row.role === "render" && (row.isFake || row.status === "verified"));

  const useTemplate = async (tpl: CreatomateTemplateSummaryResponse) => {
    if (!id || !providerAccountId) return;
    setPinning(tpl.externalTemplateId);
    try {
      const snapshot = await pinTemplateSnapshot(providerAccountId, tpl.externalTemplateId);
      navigate(`/jobs/${id}/studio`, { state: { templateSnapshotId: snapshot.id } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setPinning(null);
    }
  };

  return (
    <>
      <PageHeader
        title={t("templates.title")}
        breadcrumb={t("templates.matchCount", { count: filtered.length })}
        actions={<Button variant="secondary" onClick={() => navigate(`/jobs/${id}/studio`)}>{t("templates.back")}</Button>}
      />
      <p className="mb-4 text-[12px] text-lyx-fg-muted">{t("templates.subtitle")}</p>
      {error ? <Banner variant="danger">{error}</Banner> : null}

      <div className="mb-4">
        <Select value={providerAccountId} onChange={(event) => setProviderAccountId(event.target.value)} disabled={renderAccounts.length === 0}>
          {renderAccounts.length === 0 ? <option value="">{t("studioPro.noAccountForRole", { role: "Creatomate" })}</option> : null}
          {renderAccounts.map((account) => (
            <option key={account.id} value={account.id}>{account.name}</option>
          ))}
        </Select>
      </div>

      <div className="grid gap-6 lg:grid-cols-[180px_1fr]">
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-[11px] text-lyx-fg-muted">{t("templates.styleLabel")}</p>
            <div className="flex flex-col gap-1.5">
              <Chip active={tag === "all"} onClick={() => setTag("all")}>
                {t("templates.allStyles")}
              </Chip>
              {tags.map((item) => (
                <Chip key={item} active={tag === item} onClick={() => setTag(item)}>
                  {item}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <div>
          {loading ? <p className="text-[12px] text-lyx-fg-muted">{t("common.loading")}</p> : null}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((tpl) => (
              <div key={tpl.externalTemplateId} className="overflow-hidden rounded-[6px] border border-lyx-border">
                <div className="flex items-center justify-center overflow-hidden bg-lyx-muted text-[11px] text-lyx-fg-subtle" style={{ aspectRatio: "9 / 16" }}>
                  {tpl.previewUrl ? <img src={tpl.previewUrl} alt={tpl.name} className="h-full w-full object-cover" /> : t("templates.preview")}
                </div>
                <div className="p-2.5">
                  <div className="text-[12px] font-medium">{tpl.name}</div>
                  <div className="mt-0.5 text-[11px] text-lyx-fg-muted">{tpl.tags.join(", ") || tpl.externalTemplateId}</div>
                  <Button
                    variant="primary"
                    className="mt-2 w-full"
                    disabled={pinning === tpl.externalTemplateId}
                    onClick={() => void useTemplate(tpl)}
                  >
                    {pinning === tpl.externalTemplateId ? t("common.loading") : t("templates.useTemplate")}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-5 rounded-[6px] border border-lyx-border bg-lyx-muted p-3 text-[12px] text-lyx-fg-muted">
            {t("templates.pinNote")}
          </p>
        </div>
      </div>
    </>
  );
}
