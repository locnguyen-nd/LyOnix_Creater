import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import { TOAST_DURATION_MS, FeedbackProvider } from "./feedback";
import { Banner } from "./chrome";
import { ConfirmDialog } from "./ConfirmDialog";
import { locales } from "../i18n/locales";

const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);

describe("app-wide alerts", () => {
  it("errors stay on screen longer than successes", () => {
    expect(TOAST_DURATION_MS.danger).toBeGreaterThan(TOAST_DURATION_MS.success);
  });
  it("renders the toast region and no dialog until something is confirmed", () => {
    const out = wrap(<FeedbackProvider><p>app</p></FeedbackProvider>);
    expect(out).toContain('data-testid="toast-region"');
    expect(out).not.toContain("confirm-dialog");
  });
  it("Banner announces warnings and errors, and offers a success tone", () => {
    expect(wrap(<Banner variant="danger">x</Banner>)).toContain('role="alert"');
    expect(wrap(<Banner variant="warn">x</Banner>)).toContain('role="alert"');
    expect(wrap(<Banner variant="success">x</Banner>)).toContain('role="status"');
  });
  it("ConfirmDialog has an amber warn tone besides the red default", () => {
    const base = { open: true, title: "t", message: "m", confirmLabel: "ok", cancelLabel: "no", onConfirm: () => undefined, onCancel: () => undefined };
    expect(wrap(<ConfirmDialog {...base} tone="warn" />)).toContain("bg-lyx-warn");
    expect(wrap(<ConfirmDialog {...base} />)).toContain("bg-lyx-danger");
  });
});
