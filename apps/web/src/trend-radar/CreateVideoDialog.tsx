import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import type { TrendAssigneeResponse, TrendClusterDetailResponse, TrendDuplicateResponse } from "@lyonix/contracts";
import { ApiError } from "../api";
import { Banner, SkeletonRows } from "../components/chrome";
import { useToast } from "../components/feedback";
import { Modal } from "../components/Modal";
import { Button, Field, Select } from "../components/ui";
import { useMe } from "../session";
import { assignTrendCluster, getTrendCluster, listTrendAssignees, trendDuplicates } from "../trend-radar-api";
import { angleChoice, anglesOf, createVideoLink } from "./trend-ui";

/**
 * VE2E-158 "Tạo video": shows earlier jobs on the same topic (same source / similar title / script), lets the user pick one of the AI's
 * angles - the ones colleagues already took are marked and a free one is suggested - records who works on it, then opens the existing
 * create-video page prefilled. Nothing paid starts here: the job is only created on that page, by the user.
 * An admin can hand the topic to someone else instead (they get an in-app notification and open it themselves).
 */
export function CreateVideoDialog({ clusterId, onClose, onAssigned }: { clusterId: string; onClose: () => void; onAssigned: (cluster: TrendClusterDetailResponse) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const toast = useToast();
  const [cluster, setCluster] = useState<TrendClusterDetailResponse | null>(null);
  const [duplicates, setDuplicates] = useState<TrendDuplicateResponse[] | null>(null);
  const [assignees, setAssignees] = useState<TrendAssigneeResponse[]>([]);
  const [angle, setAngle] = useState<number | null>(null);
  const [assignee, setAssignee] = useState(me.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getTrendCluster(clusterId), trendDuplicates(clusterId).catch(() => []), me.role === "admin" ? listTrendAssignees().catch(() => []) : Promise.resolve([])])
      .then(([detail, found, people]) => {
        if (cancelled) return;
        setCluster(detail);
        setDuplicates(found);
        setAssignees(people);
        setAngle(angleChoice(detail, me.id).suggested);
      })
      .catch((err) => { if (!cancelled) setError(err instanceof ApiError ? err.message : t("common.error")); });
    return () => { cancelled = true; };
  }, [clusterId, me.id, me.role, t]);

  const choice = useMemo(() => (cluster ? angleChoice(cluster, assignee) : null), [cluster, assignee]);
  const angles = cluster ? anglesOf(cluster) : [];
  const forSomeoneElse = assignee !== me.id;

  const proceed = async () => {
    if (!cluster) return;
    setBusy(true);
    setError(null);
    try {
      const picked = angle === null ? null : angles[angle] ?? null;
      const updated = await assignTrendCluster(cluster.id, { userId: assignee, angleIndex: picked ? angle : null, angleTitle: picked?.title ?? null });
      onAssigned(updated);
      if (forSomeoneElse) {
        toast.success(t("trendRadar.create.assignedTo", { name: assignees.find((person) => person.id === assignee)?.displayName ?? "" }));
        onClose();
        return;
      }
      navigate(createVideoLink(cluster.id, picked ? angle : null));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("trendRadar.create.title")} onClose={onClose} width={640}>
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {!cluster || !choice ? <SkeletonRows label={t("common.loading")} count={3} /> : (
        <div className="flex flex-col gap-4 text-[13px]" data-testid="trend-create-video">
          <p lang="ja" className="font-semibold">{cluster.analysis?.titleJa || cluster.title}</p>

          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-lyx-fg-subtle">{t("trendRadar.create.duplicates")}</h3>
            {duplicates === null ? <SkeletonRows label={t("common.loading")} count={1} rowClassName="h-6" /> : duplicates.length === 0 ? <p className="text-lyx-fg-muted">{t("trendRadar.create.noDuplicates")}</p> : (
              <Banner variant="warn">
                <ul className="flex flex-col gap-1" data-testid="trend-duplicates">
                  {duplicates.map((found) => (
                    <li key={`${found.kind}-${found.id}`}>
                      {found.link ? <Link to={found.link} className="font-medium underline">{found.title}</Link> : <span className="font-medium">{found.title}</span>}
                      {" · "}{found.reason === "same_source" ? t("trendRadar.create.reason.same_source") : t("trendRadar.create.reason.similar_title", { percent: Math.round(found.similarity * 100) })}
                      {" · "}{new Date(found.createdAt).toLocaleDateString()}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
          </section>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-lyx-fg-subtle">{t("trendRadar.create.angle")}</legend>
            {angles.length === 0 ? <p className="text-lyx-fg-muted">{t("trendRadar.create.noAnalysis")}</p> : null}
            {angles.map((option, index) => {
              const takenBy = choice.taken.get(index);
              return (
                <label key={option.title} className={`flex cursor-pointer items-start gap-2 rounded-[var(--lyx-radius)] border p-2.5 ${angle === index ? "border-lyx-fg" : "border-lyx-border"}`}>
                  <input type="radio" name="trend-angle" className="mt-1" checked={angle === index} onChange={() => setAngle(index)} />
                  <span className="min-w-0">
                    <strong>{option.title}</strong>
                    {choice.suggested === index ? <span className="ml-2 text-[11px] font-semibold text-lyx-ok">{t("trendRadar.create.suggested")}</span> : null}
                    <span className="block text-lyx-fg-muted">{option.approach}</span>
                    {takenBy ? <span className="block text-[11px] text-lyx-warn">{t("trendRadar.create.takenBy", { name: takenBy })}</span> : null}
                  </span>
                </label>
              );
            })}
            <label className={`flex cursor-pointer items-center gap-2 rounded-[var(--lyx-radius)] border p-2.5 ${angle === null ? "border-lyx-fg" : "border-lyx-border"}`}>
              <input type="radio" name="trend-angle" checked={angle === null} onChange={() => setAngle(null)} />
              <span>{t("trendRadar.create.noAngle")}</span>
            </label>
          </fieldset>

          {me.role === "admin" && assignees.length > 0 ? (
            <Field label={t("trendRadar.create.assignee")}>
              <Select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                {assignees.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
              </Select>
            </Field>
          ) : null}

          <p className="text-[12px] text-lyx-fg-muted">{forSomeoneElse ? t("trendRadar.create.assignNote") : t("trendRadar.create.note")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>{t("trendRadar.create.cancel")}</Button>
            <Button loading={busy} onClick={() => void proceed()}>{forSomeoneElse ? t("trendRadar.create.assignOnly") : t("trendRadar.create.continue")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
