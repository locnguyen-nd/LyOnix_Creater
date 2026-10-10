import type { VideoCostResponse } from "@lyonix/contracts";

/**
 * What a finished video cost, from what the system recorded - never an invoice. Only USD amounts count (a provider that reports credits or
 * another currency stays out), and a part nobody recorded is `null`, so `totalUsd` is a floor. Pure: the callers fetch the rows.
 */
type Amount = { costAmount: unknown; costCurrency: string | null | undefined };
export type UsageEntryCost = { kind: string; costAmount: string | null; costCurrency: string | null };

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** A recorded USD amount as a number, else null (missing, not a number, negative, or not USD). */
export const usdOf = (money: Amount | null | undefined): number | null => {
  if (!money || money.costAmount === null || money.costAmount === undefined) return null;
  if ((money.costCurrency ?? "").trim().toUpperCase() !== "USD") return null;
  const value = Number(String(money.costAmount));
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const sumOrNull = (values: ReadonlyArray<number | null>): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : round4(known.reduce((sum, value) => sum + value, 0));
};

export function summarizeVideoCost(input: { render?: Amount | null; usage?: readonly UsageEntryCost[]; apifyUsd?: number | null }): VideoCostResponse {
  const usage = input.usage ?? [];
  const renderUsd = usdOf(input.render);
  const contentUsd = sumOrNull(usage.filter((entry) => entry.kind === "content").map(usdOf));
  const ttsUsd = sumOrNull(usage.filter((entry) => entry.kind === "tts").map(usdOf));
  const mediaUsd = typeof input.apifyUsd === "number" && Number.isFinite(input.apifyUsd) && input.apifyUsd >= 0 ? round4(input.apifyUsd) : null;
  return { totalUsd: sumOrNull([renderUsd, contentUsd, ttsUsd, mediaUsd]), renderUsd: renderUsd === null ? null : round4(renderUsd), contentUsd, ttsUsd, mediaUsd };
}
