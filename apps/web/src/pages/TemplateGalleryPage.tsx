import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "../components/chrome";
import { Button } from "../components/ui";
import { PLACEHOLDER_TEMPLATES, type RenderTemplate } from "../studio/creatomate-placeholder";
import { loadScaffold, saveScaffold } from "../studio/scaffold";

const CATEGORIES: Array<RenderTemplate["category"]> = ["sport", "news", "story", "product"];

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
  const [category, setCategory] = useState<RenderTemplate["category"] | "all">("all");
  const scaffold = id ? loadScaffold(id) : { templateId: null, sceneMedia: {} };
  const [currentTemplateId, setCurrentTemplateId] = useState(scaffold.templateId);

  const filtered = useMemo(
    () => PLACEHOLDER_TEMPLATES.filter((tpl) => category === "all" || tpl.category === category),
    [category],
  );

  const useTemplate = (tpl: RenderTemplate) => {
    if (!id) return;
    saveScaffold(id, { ...scaffold, templateId: tpl.id });
    setCurrentTemplateId(tpl.id);
    navigate(`/jobs/${id}/studio`);
  };

  return (
    <>
      <PageHeader
        title={t("templates.title")}
        breadcrumb={t("templates.matchCount", { count: filtered.length })}
        actions={<Button variant="secondary" onClick={() => navigate(`/jobs/${id}/studio`)}>{t("templates.back")}</Button>}
      />
      <p className="mb-4 text-[12px] text-lyx-fg-muted">{t("templates.subtitle")}</p>

      <div className="grid gap-6 lg:grid-cols-[180px_1fr]">
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-[11px] text-lyx-fg-muted">{t("templates.styleLabel")}</p>
            <div className="flex flex-col gap-1.5">
              <Chip active={category === "all"} onClick={() => setCategory("all")}>
                {t("templates.allStyles")}
              </Chip>
              {CATEGORIES.map((cat) => (
                <Chip key={cat} active={category === cat} onClick={() => setCategory(cat)}>
                  {t(`templates.style${cat.charAt(0).toUpperCase()}${cat.slice(1)}`)}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((tpl) => {
              const isCurrent = tpl.id === currentTemplateId;
              return (
                <div key={tpl.id} className={`overflow-hidden rounded-[6px] border ${isCurrent ? "border-2 border-lyx-strong" : "border-lyx-border"}`}>
                  <div className="flex items-center justify-center bg-lyx-muted text-[11px] text-lyx-fg-subtle" style={{ aspectRatio: "9 / 16" }}>
                    {t("templates.preview")}
                  </div>
                  <div className="p-2.5">
                    <div className="text-[12px] font-medium">{tpl.name}</div>
                    <div className="mt-0.5 text-[11px] text-lyx-fg-muted">
                      {tpl.aspect} · {t("templates.duration", { min: tpl.durationRangeSec[0], max: tpl.durationRangeSec[1] })} ·{" "}
                      {t("templates.slots", { count: tpl.modifications.length })}
                    </div>
                    <Button
                      variant={isCurrent ? "secondary" : "primary"}
                      className="mt-2 w-full"
                      onClick={() => useTemplate(tpl)}
                    >
                      {isCurrent ? t("templates.current") : t("templates.useTemplate")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-5 rounded-[6px] border border-lyx-border bg-lyx-muted p-3 text-[12px] text-lyx-fg-muted">
            {t("templates.pinNote")}
          </p>
        </div>
      </div>
    </>
  );
}
