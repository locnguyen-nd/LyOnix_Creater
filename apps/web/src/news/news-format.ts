/** VE2E-96: "5 phút trước" / "2 hours ago" / "10月3日" for a news time, in the UI language. */
export function relativeNewsTime(iso: string | null, nowMs: number, locale: string, justNow: string): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const seconds = Math.round((time - nowMs) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 3_600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3_600), "hour");
  if (abs < 7 * 86_400) return format.format(Math.round(seconds / 86_400), "day");
  return new Date(time).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
