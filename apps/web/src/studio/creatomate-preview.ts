/**
 * VE2E-13: thin wrapper around Creatomate's `@creatomate/preview` browser SDK.
 *
 * This SDK is a browser preview/editor only — it cannot generate the final MP4 in the
 * browser and is never used to submit a render; the server (`render-jobs.service.ts`)
 * remains the only thing that calls Creatomate's real render API and holds the API
 * secret. It loads a real `https://creatomate.com/embed` iframe scoped to a project's
 * "public token" (a deliberately client-safe credential per Creatomate's own docs,
 * distinct from the server-held render API key — see `apps/api/src/creatomate-preview.config.ts`),
 * so mounting it is a real, user-visible network action to a third party — callers should
 * only mount when the user has explicitly opted in and the required config is present,
 * never eagerly/silently.
 *
 * Per Creatomate's documented minimum requirements, this SDK only works on modern desktop
 * browsers — mobile devices are not supported at all. `isCreatomatePreviewSupported()` is a
 * best-effort, defensive check (desktop viewport + non-mobile UA); Studio must still keep
 * its existing scene-board canvas as the fallback when this returns false or the SDK
 * reports an error, per spec §3 ("Unsupported browser/device gets a clear fallback and
 * does not issue a render automatically").
 */
import { Preview } from "@creatomate/preview";

/** Creatomate's Preview SDK does not run on mobile devices at all (see minimum-requirements docs). A narrow viewport is the practical proxy available without a full device/browser capability matrix. */
const MIN_SUPPORTED_WIDTH_PX = 768;

/** Pure, DOM-free so it can be unit tested directly (the app's Vitest config runs in a plain Node environment, no jsdom) — `isCreatomatePreviewSupported()` below is the only caller that reads real `navigator`/`window`. */
export function evaluatePreviewSupport(userAgent: string, innerWidth: number): boolean {
  const looksMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  if (looksMobile) return false;
  if (innerWidth > 0 && innerWidth < MIN_SUPPORTED_WIDTH_PX) return false;
  return true;
}

export function isCreatomatePreviewSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return evaluatePreviewSupport(navigator.userAgent ?? "", window.innerWidth ?? 0);
}

export type CreatomatePreviewHandle = {
  readonly instance: Preview;
  setSource: (source: Record<string, unknown>) => Promise<void>;
  /** V04-XX: plays a template of the token's project as-is (template preview) - still no render job. */
  loadTemplate: (templateId: string) => Promise<void>;
  dispose: () => void;
};

/**
 * Mounts a player-mode Preview SDK instance into `container` and resolves once it is ready
 * (or rejects if the SDK never reports ready within `timeoutMs` — e.g. blocked by an ad
 * blocker/CSP, or a genuinely unsupported browser that never sends `onReady`).
 */
export function mountCreatomatePreview(container: HTMLDivElement, publicToken: string, timeoutMs = 15_000): Promise<CreatomatePreviewHandle> {
  return new Promise((resolve, reject) => {
    const preview = new Preview(container, "player", publicToken);
    const timer = setTimeout(() => {
      preview.dispose();
      reject(new Error("Creatomate Preview SDK did not become ready in time"));
    }, timeoutMs);
    preview.onReady = () => {
      clearTimeout(timer);
      resolve({
        instance: preview,
        setSource: (source) => preview.setSource(source),
        loadTemplate: (templateId) => preview.loadTemplate(templateId),
        dispose: () => preview.dispose(),
      });
    };
  });
}
