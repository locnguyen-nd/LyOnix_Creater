/**
 * VE2E-116: pure maths + report for `pnpm render:parity` (compare the same video rendered by two engines, e.g. internal `lyonix` vs Creatomate).
 * No process, no I/O: the CLI runs FFmpeg and feeds the raw logs/arrays in here, so everything below is unit-testable.
 */

export type Stats = { mean: number; min: number; p5: number; count: number };

export function summarize(values: readonly number[]): Stats {
  if (values.length === 0) return { mean: NaN, min: NaN, p5: NaN, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, min: sorted[0]!, p5: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.05))]!, count: values.length };
}

/** `ssim=stats_file=` lines: `n:1 Y:0.99 U:0.99 V:0.99 All:0.99 (20.1)` -> the `All` value per frame. */
export const parseSsimStats = (text: string): number[] => [...text.matchAll(/\bAll:([\d.]+)/g)].map((m) => Number(m[1])).filter(Number.isFinite);

/** `psnr=stats_file=` lines: `n:1 mse_avg:... psnr_avg:42.1 ...` -> psnr_avg per frame (inf capped at 100 dB). */
export const parsePsnrStats = (text: string): number[] =>
  [...text.matchAll(/\bpsnr_avg:(inf|[\d.]+)/g)].map((m) => (m[1] === "inf" ? 100 : Number(m[1]))).filter(Number.isFinite);

/** `libvmaf` JSON log: pooled mean. */
export function parseVmafMean(json: string): number | null {
  try {
    const mean = (JSON.parse(json) as { pooled_metrics?: { vmaf?: { mean?: number } } }).pooled_metrics?.vmaf?.mean;
    return typeof mean === "number" && Number.isFinite(mean) ? mean : null;
  } catch {
    return null;
  }
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Caption onsets from the per-frame activity (`signalstats` YDIF) of the caption band: a spike well above the typical level (median + `k` x MAD,
 * and above an absolute floor) that is a local maximum, at least `minGapSec` after the previous onset. Heuristic: reliable on a calm background,
 * noisy on busy footage - the report labels it as an estimate.
 */
export function detectOnsets(activity: readonly number[], fps: number, options: { k?: number; floor?: number; minGapSec?: number } = {}): number[] {
  const { k = 6, floor = 0.5, minGapSec = 0.25 } = options;
  if (activity.length < 3) return [];
  const med = median(activity);
  const mad = median(activity.map((v) => Math.abs(v - med))) || 0.05;
  const threshold = Math.max(floor, med + k * mad);
  const onsets: number[] = [];
  for (let i = 1; i < activity.length - 1; i += 1) {
    const v = activity[i]!;
    if (v < threshold || v < activity[i - 1]! || v < activity[i + 1]!) continue;
    const t = i / fps;
    if (onsets.length === 0 || t - onsets[onsets.length - 1]! >= minGapSec) onsets.push(t);
  }
  return onsets;
}

export type OnsetMatch = { matched: number; unmatchedA: number; unmatchedB: number; medianOffsetMs: number | null; maxAbsOffsetMs: number | null };

/** Pairs each onset of A with the nearest unused onset of B within `maxGapSec`; offset = B - A (positive: B shows the caption later). */
export function matchOnsets(a: readonly number[], b: readonly number[], maxGapSec = 0.5): OnsetMatch {
  const used = new Set<number>();
  const offsets: number[] = [];
  for (const t of a) {
    let best = -1;
    let bestGap = Infinity;
    b.forEach((u, index) => {
      const gap = Math.abs(u - t);
      if (!used.has(index) && gap < bestGap) {
        best = index;
        bestGap = gap;
      }
    });
    if (best >= 0 && bestGap <= maxGapSec) {
      used.add(best);
      offsets.push((b[best]! - t) * 1000);
    }
  }
  return {
    matched: offsets.length,
    unmatchedA: a.length - offsets.length,
    unmatchedB: b.length - used.size,
    medianOffsetMs: offsets.length ? Math.round(median(offsets)) : null,
    maxAbsOffsetMs: offsets.length ? Math.round(Math.max(...offsets.map(Math.abs))) : null,
  };
}

export type StreamInfo = { width: number | null; height: number | null; fps: number | null; durationMs: number | null; frames: number | null; videoCodec: string | null; audioCodec: string | null };
export type Loudness = { integratedLufs: number | null; truePeakDbtp: number | null };

export type ParityInput = {
  labelA: string;
  labelB: string;
  a: StreamInfo;
  b: StreamInfo;
  loudnessA: Loudness;
  loudnessB: Loudness;
  ssim: Stats;
  psnr: Stats;
  vmaf: number | null;
  /** SSIM at the sampled key frames (time in s). */
  keyframes: Array<{ timeSec: number; ssim: number | null; imageA: string; imageB: string }>;
  captions: OnsetMatch | null;
};

export type Verdict = "pass" | "warn" | "fail" | "n/a";
export type ParityRow = { metric: string; a: string; b: string; delta: string; verdict: Verdict; rule: string };

/** Indicative thresholds, proposed for the owner to tune: they are the acceptance bar of the A/B before a template's rolloutPercent is raised. */
export const PARITY_THRESHOLDS = { ssimMeanPass: 0.9, ssimMeanFail: 0.75, durationMs: 100, loudnessLu: 1, captionOffsetMs: 34 } as const;

const fmt = (value: number | null | undefined, digits = 1, unit = ""): string => (value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}${unit}`);

export function buildParityRows(input: ParityInput): ParityRow[] {
  const { a, b } = input;
  const rows: ParityRow[] = [];
  const sameSize = a.width === b.width && a.height === b.height;
  rows.push({ metric: "Resolution", a: `${a.width ?? "?"}x${a.height ?? "?"}`, b: `${b.width ?? "?"}x${b.height ?? "?"}`, delta: sameSize ? "same" : "differs", verdict: sameSize ? "pass" : "warn", rule: "same size (metrics compare a scaled copy)" });
  const fpsMatch = a.fps !== null && b.fps !== null && Math.abs(a.fps - b.fps) < 0.01;
  rows.push({ metric: "Frame rate", a: fmt(a.fps, 2, " fps"), b: fmt(b.fps, 2, " fps"), delta: fpsMatch ? "same" : "differs", verdict: fpsMatch ? "pass" : "fail", rule: "equal fps (hard requirement: 60)" });
  const dd = a.durationMs !== null && b.durationMs !== null ? b.durationMs - a.durationMs : null;
  rows.push({ metric: "Duration", a: fmt(a.durationMs, 0, " ms"), b: fmt(b.durationMs, 0, " ms"), delta: dd === null ? "—" : `${dd >= 0 ? "+" : ""}${dd.toFixed(0)} ms`, verdict: dd === null ? "n/a" : Math.abs(dd) <= PARITY_THRESHOLDS.durationMs ? "pass" : "fail", rule: `|delta| <= ${PARITY_THRESHOLDS.durationMs} ms` });
  const ld = input.loudnessA.integratedLufs !== null && input.loudnessB.integratedLufs !== null ? input.loudnessB.integratedLufs - input.loudnessA.integratedLufs : null;
  rows.push({ metric: "Integrated loudness", a: fmt(input.loudnessA.integratedLufs, 1, " LUFS"), b: fmt(input.loudnessB.integratedLufs, 1, " LUFS"), delta: ld === null ? "—" : `${ld >= 0 ? "+" : ""}${ld.toFixed(1)} LU`, verdict: ld === null ? "n/a" : Math.abs(ld) <= PARITY_THRESHOLDS.loudnessLu ? "pass" : "warn", rule: `|delta| <= ${PARITY_THRESHOLDS.loudnessLu} LU` });
  const sm = input.ssim.mean;
  rows.push({ metric: "SSIM (mean / min / p5)", a: "—", b: "—", delta: `${fmt(sm, 4)} / ${fmt(input.ssim.min, 4)} / ${fmt(input.ssim.p5, 4)}`, verdict: !Number.isFinite(sm) ? "n/a" : sm >= PARITY_THRESHOLDS.ssimMeanPass ? "pass" : sm >= PARITY_THRESHOLDS.ssimMeanFail ? "warn" : "fail", rule: `mean >= ${PARITY_THRESHOLDS.ssimMeanPass} pass, < ${PARITY_THRESHOLDS.ssimMeanFail} fail` });
  rows.push({ metric: "PSNR (mean)", a: "—", b: "—", delta: fmt(input.psnr.mean, 2, " dB"), verdict: "n/a", rule: "informational" });
  rows.push({ metric: "VMAF (mean)", a: "—", b: "—", delta: input.vmaf === null ? "not available (FFmpeg without libvmaf)" : fmt(input.vmaf, 2), verdict: "n/a", rule: "informational" });
  if (input.captions) {
    const c = input.captions;
    const off = c.medianOffsetMs;
    rows.push({
      metric: "Caption timing (estimate)",
      a: `${c.matched + c.unmatchedA} onsets`,
      b: `${c.matched + c.unmatchedB} onsets`,
      delta: off === null ? "no onsets matched" : `median ${off >= 0 ? "+" : ""}${off} ms (max ${c.maxAbsOffsetMs} ms), ${c.matched} matched`,
      verdict: off === null ? "n/a" : Math.abs(off) <= PARITY_THRESHOLDS.captionOffsetMs ? "pass" : "fail",
      rule: `|median offset| <= ${PARITY_THRESHOLDS.captionOffsetMs} ms (2 frames @ 60 fps); heuristic from caption-band activity`,
    });
  }
  return rows;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function overallVerdict(rows: readonly ParityRow[]): Verdict {
  if (rows.some((r) => r.verdict === "fail")) return "fail";
  if (rows.some((r) => r.verdict === "warn")) return "warn";
  return rows.some((r) => r.verdict === "pass") ? "pass" : "n/a";
}

export function buildParityHtml(input: ParityInput, generatedAt: Date = new Date()): string {
  const rows = buildParityRows(input);
  const overall = overallVerdict(rows);
  const color: Record<Verdict, string> = { pass: "#1a7f37", warn: "#9a6700", fail: "#cf222e", "n/a": "#6e7781" };
  const tr = rows.map((r) => `<tr><td>${escapeHtml(r.metric)}</td><td>${escapeHtml(r.a)}</td><td>${escapeHtml(r.b)}</td><td>${escapeHtml(r.delta)}</td><td style="color:${color[r.verdict]};font-weight:600">${r.verdict}</td><td class="rule">${escapeHtml(r.rule)}</td></tr>`).join("\n");
  const frames = input.keyframes
    .map((k) => `<figure><div class="pair"><img alt="A @ ${k.timeSec.toFixed(2)}s" src="${k.imageA}"><img alt="B @ ${k.timeSec.toFixed(2)}s" src="${k.imageB}"></div><figcaption>${k.timeSec.toFixed(2)} s — SSIM ${k.ssim === null ? "—" : k.ssim.toFixed(4)}</figcaption></figure>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Render parity — ${escapeHtml(input.labelA)} vs ${escapeHtml(input.labelB)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}th,td{border-color:#30363d!important}}
h1{font-size:20px;margin:0 0 4px}.sub{color:#6e7781;margin-bottom:16px}
table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left;vertical-align:top}th{background:rgba(127,127,127,.12)}
.rule{color:#6e7781;font-size:12px}.badge{display:inline-block;padding:2px 10px;border-radius:12px;color:#fff;font-weight:600}
.frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}figure{margin:0}.pair{display:flex;gap:4px}.pair img{width:50%;height:auto;border:1px solid #d0d7de}figcaption{font-size:12px;color:#6e7781;margin-top:4px}
</style></head><body>
<h1>Render parity <span class="badge" style="background:${color[overall]}">${overall}</span></h1>
<div class="sub">A = ${escapeHtml(input.labelA)} · B = ${escapeHtml(input.labelB)} · generated ${generatedAt.toISOString()}<br>Indicative thresholds (proposed, owner tunes them); the verdict is evidence for the A/B before raising a template's rolloutPercent, not a replacement for watching both videos.</div>
<table><thead><tr><th>Metric</th><th>A</th><th>B</th><th>Delta / value</th><th>Verdict</th><th>Rule</th></tr></thead><tbody>
${tr}
</tbody></table>
<h2 style="font-size:16px">Key frames (A left, B right)</h2>
<div class="frames">
${frames}
</div>
</body></html>
`;
}
