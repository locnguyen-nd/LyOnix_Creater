import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { NotificationResponse, TrendClusterResponse, TrendRunResponse } from "@lyonix/contracts";
import { TREND_NO_GROWTH_DATA } from "@lyonix/domain/trend-radar";
import { locales } from "../i18n/locales";
import { freshUnread } from "../components/notification-bell";
import { TrendCard } from "./TrendCard";
import { TrendRunsPanel } from "./TrendRunsPanel";

type Lng = "vi" | "en";
const render = async (node: React.ReactNode, lng: Lng = "vi") => {
  const instance = i18n.createInstance();
  await instance.init({ lng, resources: { [lng]: { translation: locales[lng] } }, interpolation: { escapeValue: false } });
  return renderToStaticMarkup(<I18nextProvider i18n={instance}>{node}</I18nextProvider>);
};
const noop = () => undefined;

const cluster = (over: Partial<TrendClusterResponse> = {}): TrendClusterResponse => ({
  id: "c1",
  title: "新駅の開業日が決定",
  category: "society",
  status: "new",
  saved: false,
  score: 47,
  band: "review",
  components: [
    { key: "freshness", points: 20, max: 25, reason: "Đăng cách đây 3 giờ" },
    { key: "momentum", points: 0, max: 20, reason: TREND_NO_GROWTH_DATA },
    { key: "engagement", points: 0, max: 20, reason: "Chưa có số liệu tương tác" },
    { key: "penalty", points: -5, max: 0, reason: "Trừ điểm: chỉ có tiêu đề" },
  ],
  notes: [TREND_NO_GROWTH_DATA],
  itemCount: 1,
  providers: ["yahoo_news"],
  firstSeenAt: "2026-10-10T01:00:00.000Z",
  lastSeenAt: "2026-10-10T02:00:00.000Z",
  latestPublishedAt: null,
  hashtags: ["大阪"],
  metrics: null,
  summaryVi: null,
  analysisStatus: "none",
  assignments: [{ userId: "u1", displayName: "Lan", angleIndex: 0, angleTitle: null, createdAt: "" }],
  productionRefs: [],
  topItems: [{ id: "i1", provider: "yahoo_news", sourceId: "y1", url: "https://news.yahoo.co.jp/articles/x", title: "新駅の開業日が決定", author: null, publisher: "読売新聞", excerpt: null, thumbnailUrl: null, hashtags: [], category: "society", publishedAt: null, collectedAt: "2026-10-10T02:00:00.000Z", metrics: null, completeness: "headline_only" }],
  ...over,
});

describe("VE2E-158 Trend Radar views", () => {
  it("a card explains its score and says what is not known (no growth data, no engagement numbers) instead of inventing it", async () => {
    const html = await render(<TrendCard cluster={cluster()} busy={false} onStatus={noop} onSave={noop} onCreateVideo={noop} onOpen={noop} />);
    expect(html).toContain("Worth Reviewing");
    expect(html).toContain(">47<");
    expect(html).toContain("Đăng cách đây 3 giờ");
    expect(html).toContain(TREND_NO_GROWTH_DATA);
    expect(html).toContain("Chưa có số liệu tương tác");
    expect(html).toContain("-5");
    expect(html).toContain("Phụ trách: Lan");
    expect(html).toContain("Chưa phân tích: chỉ có dữ liệu từ nguồn.");
    expect(html).toContain('href="https://news.yahoo.co.jp/articles/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    for (const action of ["Đã xem", "Lưu", "Bỏ qua", "Tạo video", "Góc khai thác &amp; kịch bản AI"]) expect(html).toContain(action);
    expect(html).not.toMatch(/Lượt xem/); // no metric labels without numbers
  });

  it("a card with real TikTok numbers shows them, measured once (not called growth)", async () => {
    const html = await render(<TrendCard cluster={cluster({ providers: ["tiktok"], metrics: { views: 1_250_000, likes: 80_000, comments: null, shares: null, measuredAt: "2026-10-10T02:00:00.000Z" } })} busy={false} onStatus={noop} onSave={noop} onCreateVideo={noop} onOpen={noop} />, "en");
    expect(html).toContain("1.3M");
    expect(html).toContain("80.0K");
    expect(html).not.toContain("Comments");
    expect(html).toContain("one measurement, not a growth rate");
  });

  it("run history: a partial run shows each source with its own status and error", async () => {
    const run: TrendRunResponse = {
      id: "r1", trigger: "manual", status: "partial", requestedByUserId: "u1", createdAt: "2026-10-10T02:00:00.000Z", startedAt: "2026-10-10T02:00:00.000Z", finishedAt: "2026-10-10T02:00:12.000Z",
      sources: [
        { provider: "yahoo_news", status: "ok", fetched: 30, new: 12, duplicates: 18, units: [], error: null, durationMs: 1200 },
        { provider: "tiktok", status: "quota_exhausted", fetched: 0, new: 0, duplicates: 0, units: [], error: { code: "PROVIDER_QUOTA_EXHAUSTED", message: "Apify hết credit" }, durationMs: 300 },
      ],
      fetchedCount: 30, newCount: 12, duplicateCount: 18, clusterCount: 10, notifiedCount: 2, analysedCount: 1, error: null,
    };
    const html = await render(<TrendRunsPanel runs={[run]} />);
    expect(html).toContain("Thành công một phần");
    expect(html).toContain("Thủ công");
    expect(html).toContain("12 giây");
    expect(html).toContain("30 thu thập · 12 mới · 18 trùng · 2 thông báo · 1 phân tích AI");
    expect(html).toContain("Hoạt động");
    expect(html).toContain("Hết quota");
    expect(html).toContain("PROVIDER_QUOTA_EXHAUSTED: Apify hết credit");
    expect(await render(<TrendRunsPanel runs={[]} />)).toContain("Chưa có lượt chạy nào.");
  });

  it("the bell pops a browser notification only for unread ones that are new since the last poll (none on the first load)", () => {
    const note = (id: string, readAt: string | null = null): NotificationResponse => ({ id, kind: "trend_radar", title: id, body: null, link: null, data: null, readAt, createdAt: "" });
    expect(freshUnread([note("a"), note("b")], null)).toEqual([]);
    expect(freshUnread([note("c"), note("d", "2026-10-10T00:00:00Z"), note("a")], new Set(["a", "b"])).map((item) => item.id)).toEqual(["c"]);
  });

  it("every Trend Radar / notification label exists in both vi and en", () => {
    const keys = (value: unknown, prefix = ""): string[] => (value && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`)) : [prefix]);
    for (const section of ["trendRadar", "notifications"] as const) expect(keys(locales.en[section]).sort()).toEqual(keys(locales.vi[section]).sort());
    expect(locales.ja.trendRadar.title).toBe("Trend Radar");
  });
});
