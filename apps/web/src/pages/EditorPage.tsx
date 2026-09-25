import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Banner, PageHeader, PreviewFrame } from "../components/chrome";
import { Button } from "../components/ui";
import { useMe, useSession } from "../session";
import { simulateRender, visibleJobs } from "../studio/store";

export function EditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const me = useMe();
  const { state, updateState } = useSession();
  const job = visibleJobs(state, me).find((j) => j.id === id);
  const [volume, setVolume] = useState(80);
  const [order, setOrder] = useState(job?.script.scenes.map((s) => s.sceneId) ?? []);
  if (!job) return <Banner variant="danger">{t("common.error")}</Banner>;
  return (
    <>
      <PageHeader
        title={t("editor.title")}
        breadcrumb={job.code}
        actions={
          <Button onClick={() => updateState((prev) => simulateRender(prev, me, job.id))}>{t("editor.send")}</Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[200px_1fr_240px]">
        <ul className="border border-lyx-border">
          {order.map((sceneId, index) => (
            <li key={sceneId} className="flex items-center justify-between border-b border-lyx-border px-3 py-2">
              <span>{sceneId}</span>
              {index > 0 ? (
                <button
                  type="button"
                  className="text-[12px] underline"
                  onClick={() => {
                    const next = [...order];
                    const prev = next[index - 1]!;
                    next[index - 1] = sceneId;
                    next[index] = prev;
                    setOrder(next);
                  }}
                >
                  ↑
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <div>
          <PreviewFrame caption={t("common.previewLabel")} />
          <p className="mt-2 text-[12px] text-lyx-fg-muted">{t("editor.previewNote")}</p>
        </div>
        <div className="flex flex-col gap-3">
          <label>
            {t("editor.volume")}: {volume}
            <input
              className="mt-1 w-full"
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </label>
          <p className="text-[12px] text-lyx-fg-muted">Template draft ×5 (B02)</p>
        </div>
      </div>
    </>
  );
}
