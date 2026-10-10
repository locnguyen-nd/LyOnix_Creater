import type { MediaPlanSegmentDiagnostics, QualityGateDiagnostics, TemplateSlotPreflightDiagnostics } from "@lyonix/contracts";

/** VE2E-151: quality-gate warnings that say the video may not stay on the chosen person (script drift / too little media of the person). */
export const PERSON_FOCUS_WARNING_CODES = ["script_off_target", "person_media_low_confidence"] as const;

export const personFocusWarnings = (gate: QualityGateDiagnostics | null | undefined): QualityGateDiagnostics["warnings"] =>
  (gate?.warnings ?? []).filter((warning) => (PERSON_FOCUS_WARNING_CODES as readonly string[]).includes(warning.code));

/** Strict person media coverage of a run ("Đúng người: 8/12 cảnh (67%)", "Cảnh bối cảnh: 4/12"); `null` when the run is not about one person. */
export function personCoverageLines(gate: QualityGateDiagnostics | null | undefined): { person: { count: number; total: number; percent: number }; context: { count: number; total: number }; generic: number; strict: boolean; ok: boolean } | null {
  const coverage = gate?.personMedia?.coverage;
  if (!coverage || coverage.totalScenes === 0) return null;
  return {
    person: { count: coverage.personSceneCount, total: coverage.totalScenes, percent: Math.round(coverage.personCoverageRatio * 100) },
    context: { count: coverage.contextSceneCount + coverage.genericSceneCount, total: coverage.totalScenes },
    generic: coverage.genericSceneCount,
    strict: Boolean(gate?.personMedia?.strict),
    ok: coverage.ok,
  };
}

/** Required template slots still missing (scene + slot) and the ones a fallback filled, from the `template_slot_preflight` step. */
export function templateSlotLines(slots: TemplateSlotPreflightDiagnostics | null | undefined): { missing: string[]; fixed: string[] } | null {
  if (!slots?.applies) return null;
  const kind = (value: "image" | "video" | null) => (value === "image" ? "ảnh" : value === "video" ? "video" : "chưa có media");
  const missing = slots.unresolved.map((issue) => `${issue.slotKey} (cảnh ${issue.sceneNumber}: cần ${issue.expectedKind ? kind(issue.expectedKind) : "ảnh hoặc video"}, đang là ${kind(issue.actualKind)})`);
  const fixed = slots.fixes.map((fix) => `${fix.slotKey} -> ${fix.fallback}`);
  return missing.length || fixed.length ? { missing, fixed } : null;
}

/** Providers that failed for the job's segments ("Apify: PROVIDER_QUOTA_EXHAUSTED - 6 đoạn"), read from the sourcing diagnostics. */
export function providerFailureLines(segments: readonly MediaPlanSegmentDiagnostics[] | null | undefined): string[] {
  const counts = new Map<string, number>();
  for (const segment of segments ?? []) {
    const reasons = [segment.fallbackReason, segment.degradeReason, segment.person?.rejectionReason].filter((value): value is string => Boolean(value));
    const seen = new Set<string>();
    for (const reason of reasons) {
      for (const part of reason.split(/;\s*/)) {
        const text = part.replace(/^(ja|en|broad|shorts|gallery|pexels):/, "").trim();
        const match = /^apify_(?:error:([A-Z_]+)|(quota_exhausted_all_accounts))/.exec(text);
        if (!match) continue;
        const label = match[2] ? "Apify: hết quota (mọi account)" : `Apify: ${match[1]}`;
        if (seen.has(label)) continue;
        seen.add(label);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  return [...counts].map(([label, n]) => `${label} - ${n} đoạn`);
}

/** VE2E-152: "Không đủ footage sạch, đang dùng media có overlay nhẹ." - medium (overlay) sources taken because nothing clean was usable. */
export const overlayFallbackWarnings = (gate: QualityGateDiagnostics | null | undefined): QualityGateDiagnostics["warnings"] =>
  (gate?.warnings ?? []).filter((warning) => warning.code === "media_overlay_fallback");
