import { useTranslation } from "react-i18next";
import type { JobStepKey } from "../studio/types";

const ORDER: JobStepKey[] = [
  "intake",
  "check",
  "script",
  "review",
  "produce",
  "edit",
  "vrew",
  "done",
];

export function JobStepper({
  current,
  failed,
  blocked,
}: {
  current: JobStepKey;
  failed?: boolean;
  blocked?: boolean;
}) {
  const { t } = useTranslation();
  const currentIndex = ORDER.indexOf(current);
  return (
    <ol className="mb-4 flex flex-wrap gap-2">
      {ORDER.map((step, index) => {
        const active = index === currentIndex;
        const tone = active && failed ? "text-lyx-danger" : active && blocked ? "text-lyx-warn" : active ? "font-semibold" : "text-lyx-fg-muted";
        return (
          <li key={step} className={`text-[12px] ${tone}`}>
            {t(`steps.${step}`)}
            {index < ORDER.length - 1 ? <span className="ml-2 text-lyx-fg-subtle">·</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
