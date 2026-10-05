import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { RenderJobResponse } from "@lyonix/contracts";
import { locales } from "../i18n/locales";
import { RenderProgress } from "./RenderProgress";

const instance = i18n.createInstance();
await instance.init({ lng: "en", resources: { en: { translation: locales.en } }, interpolation: { escapeValue: false } });

const job = (over: Partial<RenderJobResponse> = {}): RenderJobResponse => ({
  id: "job-1", projectId: "p", templateSnapshotId: "s", status: "rendering", externalJobId: null, progress: null,
  clipPreparation: { clipsTotal: 0, clipsReady: 0, failed: [] }, resultUrl: null, snapshotUrl: null, resultExpiresAt: null, attempts: 1,
  requestFingerprint: "f", costAmount: null, costCurrency: null, renderDurationMs: null, lastError: null, createdAt: "", updatedAt: "", ...over,
});
const html = (j: RenderJobResponse) => renderToStaticMarkup(<I18nextProvider i18n={instance}><RenderProgress job={j} /></I18nextProvider>);

describe("RenderProgress engine info (VE2E-113)", () => {
  it("shows the engine, why the Router chose it and the internal progress", () => {
    const out = html(job({ engine: "lyonix", routeReason: "default", progress: 42 }));
    expect(out).toContain('data-testid="render-engine"');
    expect(out).toContain("Render engine: LyOnix (self-render)");
    expect(out).toContain("Why: Internal engine (default)");
    expect(out).toContain("Rendering internally: 42%");
  });
  it("labels a fallback job with the job it replaces, and shows failed QC codes", () => {
    const out = html(job({ engine: "creatomate", routeReason: "fallback_after_error", fallbackOfJobId: "abcdef1234567890", status: "queued" }));
    expect(out).toContain("Render engine: Creatomate");
    expect(out).toContain("Fallback after an internal-engine failure");
    expect(out).toContain("Fallback job for abcdef12");
    const failed = html(job({ engine: "lyonix", status: "failed", qcFailedCodes: ["QC_LOUDNESS", "QC_FPS"], lastError: { code: "QC_LOUDNESS", message: "x" } }));
    expect(failed).toContain("QC failed: QC_LOUDNESS, QC_FPS");
  });
  it("renders budget exhaustion in plain words and leaves provider jobs (and legacy jobs without engine) as before", () => {
    expect(html(job({ engine: "lyonix", status: "failed", routeReason: "budget_exhausted", lastError: { code: "RENDER_BUDGET_EXHAUSTED", message: "m" } }))).toContain("no provider was called");
    const creatomate = html(job({ engine: "creatomate", routeReason: "template_requires_provider" }));
    expect(creatomate).toContain("Render engine: Creatomate");
    expect(creatomate).not.toContain("Rendering internally");
    expect(html(job())).not.toContain("render-engine"); // pre-VE2E-108 job: no engine block at all
  });
});
