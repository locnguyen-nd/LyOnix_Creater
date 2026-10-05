import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "../components/ui";

export function DeniedPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[50vh] flex-col items-start gap-4">
      <h1 className="text-[20px] font-semibold">{t("denied.title")}</h1>
      <Link to="/">
        <Button>{t("common.deniedCta")}</Button>
      </Link>
    </div>
  );
}
