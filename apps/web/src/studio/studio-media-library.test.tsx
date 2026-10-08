import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { MediaAssetVersionSummary } from "@lyonix/contracts";
import type { MediaPickerProps } from "./MediaPicker";

const { MediaPicker } = await import("./MediaPicker");
const { EditorTabs, PanelRail, PanelToggleButton } = await import("./StudioWorkspaceControls");
const { browserApiUrl, deliveryUrlForBrowser } = await import("./media-url");
const { libraryView, thumbPrefetchIds } = await import("./media-picker-utils");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "vi", resources: { vi: { translation: locales.vi } }, interpolation: { escapeValue: false } });
const html = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);

const API = "http://localhost:3000";

const asset = (id: string, overrides: Partial<MediaAssetVersionSummary> = {}): MediaAssetVersionSummary => ({
  id, projectId: "p1", folderId: null, kind: "video", originalFileName: `${id}.mp4`, mimeType: "video/mp4", checksumSha256: "x", bytes: 1,
  widthPx: 1080, heightPx: 1920, durationMs: 8000, origin: "pexels", license: null, reusable: true, retentionClass: "standard" as MediaAssetVersionSummary["retentionClass"],
  expiresAt: null, version: 1, createdAt: "2026-10-08T00:00:00.000Z", sceneId: null, attribution: null, ...overrides,
} as MediaAssetVersionSummary);

const pickerProps = (overrides: Partial<MediaPickerProps> = {}): MediaPickerProps => ({
  projectId: "p1",
  library: [],
  libraryStatus: "ready",
  onRetryLibrary: () => undefined,
  thumbCache: {},
  thumbErrors: {},
  onThumbError: () => undefined,
  selectedAssetId: null,
  selectedSceneLabel: "#1",
  onAssign: () => undefined,
  pexels: { hasAccount: true, query: "", setQuery: () => undefined, type: "video", setType: () => undefined, results: null, searching: false, keywordChips: [], onSearch: () => undefined, onImport: () => undefined },
  apify: { accountId: null, visualPlan: null, selectedSceneId: null, fallbackKeyword: "", onImported: () => undefined },
  upload: { segmentDurations: [], onUploaded: () => undefined, onApplyShorts: () => undefined },
  ...overrides,
});

describe("browser media URLs (root cause: PUBLIC_BASE_URL is the provider-facing tunnel)", () => {
  it("re-points our streaming routes from a dead tunnel to the API origin", () => {
    expect(browserApiUrl("https://dead.trycloudflare.com/api/v1/media-delivery/tok123", API)).toBe(`${API}/api/v1/media-delivery/tok123`);
    expect(browserApiUrl("https://dead.trycloudflare.com/api/v1/render-jobs/job-1/file", API)).toBe(`${API}/api/v1/render-jobs/job-1/file`);
    expect(browserApiUrl("/api/v1/media-delivery/tok123", `${API}/`)).toBe(`${API}/api/v1/media-delivery/tok123`);
    expect(browserApiUrl("https://x.example/api/v1/render-jobs/job-1/thumbnail?v=2#t=1", API)).toBe(`${API}/api/v1/render-jobs/job-1/thumbnail?v=2#t=1`);
  });

  it("leaves provider CDN, blob and data URLs (and other API routes) untouched", () => {
    const cdn = "https://f002.backblazeb2.com/file/creatomate/render.mp4";
    expect(browserApiUrl(cdn, API)).toBe(cdn);
    expect(browserApiUrl("blob:http://localhost:5173/abc", API)).toBe("blob:http://localhost:5173/abc");
    expect(browserApiUrl("data:image/png;base64,AAAA", API)).toBe("data:image/png;base64,AAAA");
    expect(browserApiUrl("https://cdn.example/api/v1/projects/p1", API)).toBe("https://cdn.example/api/v1/projects/p1");
    expect(browserApiUrl(null, API)).toBeNull();
    expect(browserApiUrl("", API)).toBeNull();
  });

  it("uses the token path when the API returns one, else the old absolute url", () => {
    expect(deliveryUrlForBrowser({ url: "https://dead.example/api/v1/media-delivery/a", path: "/api/v1/media-delivery/a" }, API)).toBe(`${API}/api/v1/media-delivery/a`);
    expect(deliveryUrlForBrowser({ url: "https://dead.example/api/v1/media-delivery/b" }, API)).toBe(`${API}/api/v1/media-delivery/b`);
  });
});

describe("library state and thumbnail prefetch", () => {
  it("libraryView never blanks: skeleton, error, empty, no-match or grid", () => {
    expect(libraryView("loading", 0, 0)).toBe("loading");
    expect(libraryView("failed", 0, 0)).toBe("failed");
    expect(libraryView("ready", 0, 0)).toBe("empty");
    expect(libraryView("ready", 3, 0)).toBe("no-match");
    expect(libraryView("ready", 3, 3)).toBe("grid");
    // rows already shown stay when a refresh is loading or failed
    expect(libraryView("failed", 3, 3)).toBe("grid");
    expect(libraryView("loading", 3, 3)).toBe("grid");
  });

  it("prefetches every visual original, not the first 12 raw rows", () => {
    const noise = Array.from({ length: 14 }, (_, index) => asset(`audio-${index}`, { kind: "audio" }));
    const derivatives = [asset("clip-1", { parentMediaAssetVersionId: "orig-1" } as Partial<MediaAssetVersionSummary>)];
    const originals = [asset("orig-1"), asset("orig-2", { kind: "image" })];
    const ids = thumbPrefetchIds({ sceneMediaIds: ["scene-media", null], audioIds: ["voice-1"], library: [...noise, ...derivatives, ...originals], failed: {}, max: 120 });
    expect(ids).toEqual(["scene-media", "voice-1", "orig-1", "orig-2"]);
  });

  it("skips failed previews and respects the cache cap (timeline media first)", () => {
    const library = [asset("a"), asset("b"), asset("c")];
    expect(thumbPrefetchIds({ sceneMediaIds: ["s1"], audioIds: [], library, failed: { b: "LOAD_FAILED" }, max: 120 })).toEqual(["s1", "a", "c"]);
    expect(thumbPrefetchIds({ sceneMediaIds: ["s1"], audioIds: [], library, failed: {}, max: 2 })).toEqual(["s1", "a"]);
  });
});

describe("MediaPicker library tab", () => {
  it("shows a skeleton while loading", () => {
    const out = html(<MediaPicker {...pickerProps({ libraryStatus: "loading" })} />);
    expect(out).toContain('data-testid="library-loading"');
    expect(out).toContain("Đang tải thư viện");
  });

  it("shows an error with Retry when the library request failed", () => {
    const out = html(<MediaPicker {...pickerProps({ libraryStatus: "failed" })} />);
    expect(out).toContain('data-testid="library-failed"');
    expect(out).toContain('role="alert"');
    expect(out).toContain("Không tải được thư viện");
    expect(out).toContain("Thử lại");
  });

  it("shows an empty state with next steps when the project has no image/video", () => {
    const out = html(<MediaPicker {...pickerProps({ library: [asset("voice", { kind: "audio" })] })} />);
    expect(out).toContain('data-testid="library-empty"');
    expect(out).toContain("Thư viện project chưa có ảnh/video");
    expect(out).toContain("Tìm trên Pexels");
    expect(out).toContain("Chọn tệp");
  });

  it("renders tiles: pending ones as a placeholder, failed ones with a clear fallback and a Retry banner", () => {
    const out = html(<MediaPicker {...pickerProps({ library: [asset("ok"), asset("pending"), asset("broken")], thumbCache: { ok: `${API}/api/v1/media-delivery/t1` }, thumbErrors: { broken: "PROVIDER_NOT_CONFIGURED" } })} />);
    expect(out).toContain('title="ok.mp4"');
    expect(out).toContain('aria-label="Đang tải bản xem trước"');
    expect(out).toContain("Không xem trước được");
    expect(out).toContain("1 tệp không tải được bản xem trước.");
    expect(out).not.toContain('data-testid="library-empty"');
  });
});

describe("Studio workspace controls", () => {
  it("panel switches are labelled edit buttons with icon, state and target panel", () => {
    const open = html(<PanelToggleButton side="left" open onToggle={() => undefined} />);
    expect(open).toContain('aria-pressed="true"');
    expect(open).toContain('aria-controls="studio-editor-panel"');
    expect(open).toContain("Chỉnh sửa nội dung");
    expect(open).toContain("Kịch bản · Voice · Media");
    expect(open).toContain("Ẩn</span>");
    expect(open).toContain('title="Ẩn vùng Kịch bản/Voice/Media"');
    expect(open).toContain("<svg");

    const closed = html(<PanelToggleButton side="right" open={false} onToggle={() => undefined} />);
    expect(closed).toContain('aria-pressed="false"');
    expect(closed).toContain('aria-controls="studio-inspector-panel"');
    expect(closed).toContain("Chỉnh sửa cảnh");
    expect(closed).toContain("Hiện</span>");
    expect(closed).toContain("lyx-accent-amber");
  });

  it("a collapsed panel leaves a rail that names it", () => {
    const out = html(<PanelRail side="left" onOpen={() => undefined} />);
    expect(out).toContain('aria-label="Hiện vùng Kịch bản/Voice/Media"');
    expect(out).toContain("lyx-panel-rail-label");
    expect(out).toContain("Chỉnh sửa nội dung");
  });

  it("editor tabs: three tool tabs with icons, captions and one selected tab", () => {
    const out = html(<EditorTabs active="media" onChange={() => undefined} captions={{ script: "6 cảnh", voice: "2/6 cảnh có giọng", media: "5 ảnh/video" }} />);
    expect(out.match(/role="tab"/g)).toHaveLength(3);
    expect(out.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(out).toMatch(/id="studio-tab-media"[^>]*aria-selected="true"/);
    expect(out).toContain('aria-controls="studio-tabpanel-script"');
    for (const text of ["Kịch bản", "Voice", "Media", "6 cảnh", "2/6 cảnh có giọng", "5 ảnh/video"]) expect(out).toContain(text);
    expect(out.match(/<svg/g)?.length).toBeGreaterThanOrEqual(3);
    for (const accent of ["lyx-accent-blue", "lyx-accent-violet", "lyx-accent-green"]) expect(out).toContain(accent);
  });
});
