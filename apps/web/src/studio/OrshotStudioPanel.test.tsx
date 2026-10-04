import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { OrshotStudioPanelProps } from "./OrshotStudioPanel";

vi.mock("../session", () => ({ useMe: () => ({ id: "user-1", role: "staff" }) }));
vi.mock("./timeline-api", () => ({ fetchOrshotEstimate: vi.fn(), listCreatomateTemplates: vi.fn(async () => []), pinTemplateSnapshot: vi.fn(), reconcileRenderJob: vi.fn() }));

const { OrshotStudioPanel } = await import("./OrshotStudioPanel");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "en", resources: { en: { translation: locales.en } }, interpolation: { escapeValue: false } });

const base = (model: string): OrshotStudioPanelProps => ({
  account: { id: "acc-1", name: "Orshot", provider: "orshot", role: "render", model } as OrshotStudioPanelProps["account"],
  projectId: "p1", timelineVersionId: null, timelineApproved: false, dirty: false, template: null,
  supply: { scenes: 0, videos: 0, images: 0, voices: 0 }, options: { fitDurationToNarration: true }, onOptionsChange: () => undefined,
  renderJob: null, onRenderJobChange: () => undefined, submitting: false, onSubmit: () => undefined, onPinned: () => undefined, onBackToClassic: () => undefined,
});

const html = (props: OrshotStudioPanelProps) => renderToStaticMarkup(<I18nextProvider i18n={instance}><OrshotStudioPanel {...props} /></I18nextProvider>);

describe("OrshotStudioPanel (first paint)", () => {
  it("embeds the Orshot iframe for an account with an Embed ID, from https://orshot.com only", () => {
    const out = html(base("emb12345"));
    expect(out).toContain('src="https://orshot.com/embeds/emb12345?lang=en"');
    expect(out).toContain('data-testid="orshot-studio-panel"');
    expect(out).not.toContain("no Embed ID");
  });
  it("shows setup guidance instead of an iframe when no Embed ID is configured, and still offers the way back", () => {
    const out = html(base("n/a"));
    expect(out).not.toContain("<iframe");
    expect(out).toContain("Back to classic editor");
  });
  it("never puts an unsafe Embed ID into the iframe URL", () => {
    expect(html(base("../evil"))).not.toContain("<iframe");
  });
});
