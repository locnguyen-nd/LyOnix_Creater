import type { MediaAssetVersionSummary } from "@lyonix/contracts";
import type { ShortsPlan } from "./auto-shorts";

export const LIBRARY_FILTERS = ["all", "pexels", "apify", "upload", "other"] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number];

/** Only visuals (video/image) are offered; clip derivatives (VE2E-37 lineage rows) and generated voice audio never are. */
export function filterLibrary(library: readonly MediaAssetVersionSummary[], filter: LibraryFilter): MediaAssetVersionSummary[] {
  return library.filter((asset) => {
    if (asset.kind !== "video" && asset.kind !== "image") return false;
    if (asset.parentMediaAssetVersionId) return false;
    if (filter === "all") return true;
    if (filter === "upload") return asset.origin === "upload" || asset.origin === "import_url";
    if (filter === "other") return asset.origin === "generated";
    return asset.origin === filter;
  });
}

export type LibraryStatus = "loading" | "ready" | "failed";
export type LibraryView = "loading" | "failed" | "empty" | "no-match" | "grid";

/**
 * What the library tab shows. Rows already on screen win over a refresh that is loading or failed, so a working grid is never
 * blanked; with no rows the request state decides (skeleton / error with Retry / empty with next steps).
 */
export function libraryView(status: LibraryStatus, visualCount: number, matchCount: number): LibraryView {
  if (visualCount === 0) return status === "ready" ? "empty" : status;
  return matchCount === 0 ? "no-match" : "grid";
}

/**
 * Assets whose signed preview URL Studio fetches: the timeline's own media and voice first, then every visual library
 * original (what the library grid shows), up to `max` (the thumbnail cache size). Ids that already failed are skipped until
 * the user presses Retry, so a broken file is not re-requested on every render.
 */
export function thumbPrefetchIds(input: {
  sceneMediaIds: readonly (string | null | undefined)[];
  audioIds: readonly string[];
  library: readonly MediaAssetVersionSummary[];
  failed: Readonly<Record<string, string>>;
  max: number;
}): string[] {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id && !input.failed[id] && ids.size < input.max) ids.add(id);
  };
  input.sceneMediaIds.forEach(add);
  input.audioIds.forEach(add);
  for (const asset of filterLibrary(input.library, "all")) add(asset.id);
  return [...ids];
}

export function formatClock(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Positions of the planned windows along the source, as percentages, for the preview bar. */
export function applyShortsPlanPreview(plan: ShortsPlan, sourceDurationMs: number) {
  return plan.windows.map((window) => ({
    segmentId: window.segmentId,
    startMs: window.startMs,
    fits: window.fits,
    leftPct: Math.min(100, (window.startMs / sourceDurationMs) * 100),
    widthPct: (window.durationMs / sourceDurationMs) * 100,
  }));
}
