import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import { API_ORIGIN } from "../api";

const { RunResultPlayer } = await import("./RunResultPlayer");
const { locales } = await import("../i18n/locales");
const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });

const render = (resultUrl: string) => renderToStaticMarkup(<I18nextProvider i18n={instance}><RunResultPlayer resultUrl={resultUrl} /></I18nextProvider>);
const srcs = (markup: string) => [...markup.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);

describe("RunResultPlayer", () => {
  it("plays an internal render from the API origin even when it was stored with an expired tunnel address", () => {
    const out = render("https://old-quick-tunnel.trycloudflare.com/api/v1/render-jobs/job-1/file");
    const expected = `${API_ORIGIN}/api/v1/render-jobs/job-1/file`;
    expect(srcs(out)).toEqual([expected, expected, expected]); // <video>, Open, Download
    expect(out).not.toContain("trycloudflare");
    expect(out).toContain('data-testid="run-result-video"');
  });

  it("re-points a relative internal path too (PUBLIC_BASE_URL not set)", () => {
    expect(srcs(render("/api/v1/render-jobs/job-2/file"))[0]).toBe(`${API_ORIGIN}/api/v1/render-jobs/job-2/file`);
  });

  it("leaves a provider's own CDN link untouched", () => {
    const url = "https://cdn.creatomate.com/renders/abc.mp4";
    expect(srcs(render(url))).toEqual([url, url, url]);
  });
});
