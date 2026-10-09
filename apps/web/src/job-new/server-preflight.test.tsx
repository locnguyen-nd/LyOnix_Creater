import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { AutoPreflightResponse } from "@lyonix/contracts";

const { ServerPreflightPanel, serverPreflightBlocks } = await import("./ServerPreflight");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });
const html = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);

const result = (checks: AutoPreflightResponse["checks"]): AutoPreflightResponse => ({ ok: checks.every((check) => check.ok || check.severity === "warn"), checkedAt: "2026-10-09T02:00:00Z", checks });
const workerDown = { key: "worker" as const, ok: false, severity: "block" as const, message: "Worker xử lý video (apps/worker) không chạy", fix: "Chạy `corepack pnpm --filter @lyonix/worker dev`" };
const tunnelWarn = { key: "public_base_url" as const, ok: false, severity: "warn" as const, message: "PUBLIC_BASE_URL là tunnel tạm (trycloudflare)", fix: "Dùng domain cố định" };
const okCheck = { key: "template" as const, ok: true, severity: "block" as const, message: "Template render được", fix: null };

describe("create-video server preflight", () => {
  it("a blocking problem (worker down) disables create and shows the fix; a warning alone does not block", () => {
    const blocked = { status: "ready" as const, result: result([workerDown, tunnelWarn, okCheck]) };
    expect(serverPreflightBlocks(blocked)).toBe(true);
    const out = html(<ServerPreflightPanel state={blocked} />);
    expect(out).toContain('data-testid="preflight-worker"');
    expect(out).toContain("apps/worker");
    expect(out).toContain("corepack pnpm --filter @lyonix/worker dev");
    expect(out).toContain('data-testid="preflight-public_base_url"');
    expect(out).not.toContain("Template render được");
    expect(out.indexOf("preflight-worker")).toBeLessThan(out.indexOf("preflight-public_base_url"));

    const warnOnly = { status: "ready" as const, result: result([tunnelWarn, okCheck]) };
    expect(serverPreflightBlocks(warnOnly)).toBe(false);
  });

  it("all ready, checking, and an unreachable check (never blocks by itself)", () => {
    expect(html(<ServerPreflightPanel state={{ status: "ready", result: result([okCheck]) }} />)).toContain("đều sẵn sàng");
    expect(html(<ServerPreflightPanel state={{ status: "loading", previous: null }} />)).toContain("Đang kiểm tra");
    const failed = { status: "failed" as const };
    expect(serverPreflightBlocks(failed)).toBe(false);
    expect(html(<ServerPreflightPanel state={failed} />)).toContain("server vẫn kiểm tra lại");
    expect(html(<ServerPreflightPanel state={{ status: "idle" }} />)).toBe("");
    // while re-checking, the previous answer keeps blocking (no flicker into "ready")
    expect(serverPreflightBlocks({ status: "loading", previous: result([workerDown]) })).toBe(true);
  });
});
