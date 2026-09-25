import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Banner, PageHeader } from "../components/chrome";
import { Button, Field, TextInput } from "../components/ui";
import { useMe, useSession } from "../session";
import { visibleJobs } from "../studio/store";

export function LongformPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const me = useMe();
  const { state } = useSession();
  const job = visibleJobs(state, me).find((j) => j.id === id);
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState("");
  if (!job) return <Banner variant="danger">{t("common.error")}</Banner>;
  return (
    <>
      <PageHeader title={t("longform.title")} breadcrumb={job.code} />
      <div className="mb-4 flex gap-2">
        {[1, 2, 3, 4].map((item) => (
          <Button key={item} variant={step === item ? "primary" : "secondary"} onClick={() => setStep(item)}>
            {item}. {t(["longform.source", "longform.transcript", "longform.highlight", "longform.split"][item - 1]!)}
          </Button>
        ))}
      </div>
      {step === 1 ? (
        <Field label="URL">
          <TextInput value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
      ) : null}
      {step === 2 ? <p className="text-lyx-fg-muted">00:00 — (auto)</p> : null}
      {step === 3 ? <Banner variant="warn">{t("longform.autoEmpty")}</Banner> : null}
      {step === 4 ? <p>{t("common.comingSoon")}</p> : null}
    </>
  );
}
