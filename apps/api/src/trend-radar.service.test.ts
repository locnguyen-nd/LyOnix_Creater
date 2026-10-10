import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type TikTokTrendRunner } from "@lyonix/providers";

// Nothing here reaches Yahoo, Apify, TikTok or Gemini: feeds / Actor output / oEmbed / the model are fixtures and mocks.
const generate = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@lyonix/providers", async (importOriginal) => ({ ...(await importOriginal<typeof import("@lyonix/providers")>()), generateContentOnce: generate.fn }));
vi.mock("./secret-crypto.js", () => ({ decryptSecret: () => "decrypted-key" }));

const { fakeTrendPrisma } = await import("./trend-radar.fake-prisma.js");
const { NotificationsService } = await import("./notifications.service.js");
const { TrendAnalysisService } = await import("./trend-analysis.service.js");
const { TrendRadarConfigService } = await import("./trend-radar-config.service.js");
const { TrendRadarSchedulerService } = await import("./trend-radar-scheduler.service.js");
const { TrendRadarService } = await import("./trend-radar.service.js");

const NOW = new Date("2026-10-10T12:00:00Z");

const rss = (items: Array<{ title: string; id: string; minutesAgo: number }>) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>fixture</title>${items
  .map((item) => `<item><title>${item.title}</title><link>https://news.yahoo.co.jp/articles/${item.id}?source=rss</link><pubDate>${new Date(NOW.getTime() - item.minutesAgo * 60_000).toUTCString()}</pubDate><description>${item.title}の詳細</description></item>`)
  .join("")}</channel></rss>`;

const SPORTS = rss([
  { title: "架空投手が7回1失点の快投 突破に王手 (スポーツ架空)", id: "aaaa1111", minutesAgo: 30 },
  { title: "架空リーグ開幕戦のチケット完売 (バスケ架空)", id: "bbbb2222", minutesAgo: 90 },
]);
const ENTERTAINMENT = rss([{ title: "架空投手が7回1失点の快投、突破に王手 (日刊架空)", id: "cccc3333", minutesAgo: 20 }]);

const respond = (status: number, body: string) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body });

const actorItem = (id: string, text: string, views: number) => ({
  id,
  text,
  createTimeISO: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
  authorMeta: { name: `creator_${id.slice(-3)}` },
  webVideoUrl: `https://www.tiktok.com/@creator_${id.slice(-3)}/video/${id}`,
  playCount: views,
  diggCount: Math.round(views * 0.06),
  commentCount: 300,
  shareCount: 500,
  hashtags: [{ name: "アニメ" }],
});

function setup(options: { tiktok?: TikTokTrendRunner; feeds?: Record<string, () => ReturnType<typeof respond>> } = {}) {
  const { prisma, db } = fakeTrendPrisma();
  db.users.push(
    { id: "u-admin", displayName: "Admin", role: "admin", disabled: false, approved: true },
    { id: "u-staff", displayName: "Staff A", role: "staff", disabled: false, approved: true },
    { id: "u-staff2", displayName: "Staff B", role: "staff", disabled: false, approved: true },
    { id: "u-off", displayName: "Disabled", role: "staff", disabled: true, approved: true },
  );
  db.accounts.push(
    { id: "apify-1", name: "Apify org", provider: "apify", role: "visual", scope: "organization", status: "verified", enabled: true, encryptedSecret: "enc", deletedAt: null },
    { id: "gem-1", name: "Gemini org", provider: "gemini", role: "content", scope: "organization", status: "verified", enabled: true, model: "gemini-2.5-flash", preferredModels: [], encryptedSecret: "enc", isFake: false, deletedAt: null, createdAt: new Date("2026-01-01") },
  );
  let now = new Date(NOW);
  const feeds = options.feeds ?? { sports: () => respond(200, SPORTS), entertainment: () => respond(200, ENTERTAINMENT) };
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith("https://www.tiktok.com/oembed")) return feeds.oembed ? feeds.oembed() : respond(404, "");
    const key = Object.keys(feeds).find((name) => url.includes(name));
    return key ? feeds[key]!() : respond(503, "down");
  });
  const tiktok = vi.fn(options.tiktok ?? (async () => ({ runId: "r", items: [] })));
  const accounts = { getModelAvailability: vi.fn(async () => ({ available: true, retryAt: null })), markModelLimited: vi.fn(async (_id: string, _model: string, ms?: number) => new Date(now.getTime() + (ms ?? 60_000))) };
  const config = new TrendRadarConfigService(prisma);
  const notifications = new NotificationsService(prisma);
  const analysis = new TrendAnalysisService(prisma, config, accounts as never);
  const radar = new TrendRadarService(prisma, config, analysis, notifications, { fetch, tiktokRunner: tiktok, probeApify: vi.fn(async () => ({})), now: () => now });
  return { prisma, db, config, radar, analysis, notifications, fetch, tiktok, accounts, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const runOnce = async (radar: InstanceType<typeof TrendRadarService>, trigger: "manual" | "schedule" = "manual") => {
  const requested = await radar.requestRun(trigger, trigger === "manual" ? "u-admin" : null);
  await radar.settle();
  return { requested, run: requested.run ? (await radar.run(requested.run.id))! : null };
};

describe("Trend Radar runs (VE2E-158)", () => {
  const savedEnv = process.env.NEWS_SOURCES;
  beforeEach(() => {
    process.env.NEWS_SOURCES = "yahoo_jp"; // the operator confirmed the Yahoo rights - only in the tests that need it (see below)
    generate.fn.mockReset();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NEWS_SOURCES;
    else process.env.NEWS_SOURCES = savedEnv;
  });

  it("Yahoo needs the operator's rights confirmation: without it enabling is refused and a run fetches nothing", async () => {
    delete process.env.NEWS_SOURCES;
    const { config, radar, fetch, db } = setup();
    expect(await config.update({ yahooEnabled: true }, "u-admin")).toMatchObject({ ok: false, message: expect.stringContaining("Chưa xác nhận quyền sử dụng") });
    // the daily automatic Gemini budget can be lowered, never raised past 5
    expect(await config.update({ autoAnalysisPerDay: 6 }, "u-admin")).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await config.update({ autoAnalysisPerDay: 3 }, "u-admin")).toMatchObject({ ok: true });
    await config.view();
    db.config[0]!.yahooEnabled = true; // even if the flag is set by other means, the run still refuses
    const { run } = await runOnce(radar);
    expect(fetch).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: "failed", error: { code: "NO_SOURCE_AVAILABLE" } });
    expect(run!.sources.find((source) => source.provider === "yahoo_news")).toMatchObject({ status: "rights_unconfirmed" });
    expect((await config.view()).yahooRightsConfirmed).toBe(false);
  });

  it("Chạy ngay twice -> ONE run (the second returns the active one); a run abandoned by a crashed process is failed and a new one starts", async () => {
    const { config, radar, db, advance } = setup();
    await config.update({ yahooEnabled: true }, "u-admin");
    const [first, second] = await Promise.all([radar.requestRun("manual", "u-admin"), radar.requestRun("manual", "u-staff")]);
    expect(first.started).toBe(true);
    expect(second).toMatchObject({ started: false, reason: "already_running" });
    expect(second.run!.id).toBe(first.run!.id);
    await radar.settle();
    expect(db.runs).toHaveLength(1);
    // clicking again right after it finished returns that run instead of starting another
    expect(await radar.requestRun("manual", "u-admin")).toMatchObject({ started: false, reason: "just_ran", run: { id: first.run!.id } });

    db.runs.push({ id: "stuck", trigger: "manual", status: "running", createdAt: new Date(NOW.getTime() - 60 * 60_000), sources: [] });
    advance(2 * 60_000);
    const third = await radar.requestRun("manual", "u-admin");
    await radar.settle();
    expect(third.started).toBe(true);
    expect(db.runs.find((run) => run.id === "stuck")).toMatchObject({ status: "failed", error: { code: "RUN_ABANDONED" } });
  });

  it("scheduler: nothing to run -> no run (no call); due -> a run; right after -> not due; switched off -> nothing", async () => {
    const { config, radar, db, advance } = setup();
    const scheduler = new TrendRadarSchedulerService(radar, { addInterval: vi.fn(), deleteInterval: vi.fn() } as never);
    expect(await scheduler.tick()).toBe("no_source");
    expect(db.runs).toHaveLength(0);
    await config.update({ yahooEnabled: true, intervalMinutes: 30 }, "u-admin");
    expect(await scheduler.tick()).toBe("started");
    await radar.settle();
    advance(10 * 60_000);
    expect(await scheduler.tick()).toBe("not_due");
    advance(25 * 60_000);
    expect(await scheduler.tick()).toBe("started");
    await radar.settle();
    await config.update({ scheduleEnabled: false }, "u-admin");
    advance(60 * 60_000);
    expect(await scheduler.tick()).toBe("schedule_off");
    expect(db.runs.map((run) => run.trigger)).toEqual(["schedule", "schedule"]);
  });

  it("one failing source never fails the others: TikTok out of Apify credit + a Yahoo feed down -> partial run, Yahoo items kept, no fake numbers", async () => {
    const quota: TikTokTrendRunner = async () => {
      throw new ProviderError("PROVIDER_QUOTA_EXHAUSTED", "Monthly usage hard limit exceeded", false);
    };
    const { config, radar, tiktok, db } = setup({ tiktok: quota });
    await config.update({ yahooEnabled: true, yahooCategories: ["sports", "entertainment", "japan"], tiktokEnabled: true, tiktokAccountId: "apify-1", keywords: ["アニメ"], hashtags: ["ゲーム"] }, "u-admin");
    const { run } = await runOnce(radar);
    expect(run).toMatchObject({ status: "partial" });
    const yahoo = run!.sources.find((source) => source.provider === "yahoo_news")!;
    const tiktokResult = run!.sources.find((source) => source.provider === "tiktok")!;
    expect(yahoo).toMatchObject({ status: "partial", new: 3 });
    expect(yahoo.units.find((unit) => unit.unit === "yahoo:japan")).toMatchObject({ ok: false });
    expect(tiktokResult).toMatchObject({ status: "quota_exhausted", error: { code: "PROVIDER_QUOTA_EXHAUSTED" }, new: 0 });
    expect(tiktok).toHaveBeenCalledTimes(1); // quota stops the source: no second paid query
    expect(db.items.every((item) => item.provider === "yahoo_news" && item.metrics === null)).toBe(true);
    const overview = await radar.overview();
    expect(overview.problems).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "tiktok", code: "PROVIDER_QUOTA_EXHAUSTED" }), expect.objectContaining({ provider: "yahoo_news" })]));
  });

  it("de-duplication + topics: the same headline from two publishers is ONE topic with both links; a second run counts duplicates and measures growth", async () => {
    const { config, radar, db, advance } = setup();
    await config.update({ yahooEnabled: true, yahooCategories: ["sports", "entertainment"] }, "u-admin");
    const first = (await runOnce(radar)).run!;
    expect(first).toMatchObject({ status: "completed", newCount: 3, duplicateCount: 0 });
    const pitching = db.clusters.find((cluster) => cluster.title.includes("快投"))!;
    expect(db.items.filter((item) => item.clusterId === pitching.id).map((item) => item.publisher).sort()).toEqual(["スポーツ架空", "日刊架空"]);
    expect(db.clusters).toHaveLength(2);
    const detail = (await radar.clusterDetail(pitching.id))!;
    expect(detail.items.map((item) => item.url)).toEqual(expect.arrayContaining(["https://news.yahoo.co.jp/articles/aaaa1111", "https://news.yahoo.co.jp/articles/cccc3333"]));
    expect(detail.components.find((component) => component.key === "sources")).toMatchObject({ points: 10, reason: "Xuất hiện ở 2 nguồn" });
    expect(detail.components.find((component) => component.key === "momentum")).toMatchObject({ points: 0, reason: "Chưa đủ dữ liệu để xác nhận mức độ tăng trưởng" });
    expect(detail.components.find((component) => component.key === "engagement")).toMatchObject({ points: 0, reason: "Chưa có số liệu tương tác" });

    advance(45 * 60_000);
    const second = (await runOnce(radar)).run!;
    expect(second).toMatchObject({ newCount: 0, duplicateCount: 3 });
    expect(db.items).toHaveLength(3);
    const again = (await radar.clusterDetail(pitching.id))!;
    expect(again.components.find((component) => component.key === "momentum")!.reason).toContain("Không tăng giữa hai lần quét (2 → 2)");
    expect(again.history.map((entry) => entry.itemCount)).toEqual([2, 2]);
  });

  it("notifications: once per topic per band for every active user, never again on the next run; read state per user", async () => {
    const { config, radar, db, notifications, advance } = setup();
    await config.update({ yahooEnabled: true, yahooCategories: ["sports", "entertainment"], thresholds: { hot: 60, rising: 35, review: 20 }, notifyMinScore: 35, keywords: ["快投"], categories: ["sports"] }, "u-admin");
    await runOnce(radar);
    const pitching = db.clusters.find((cluster) => cluster.title.includes("快投"))!;
    expect(pitching.band).toBe("rising");
    expect(db.notifications.filter((n) => n.dedupeKey === `trend:${pitching.id}:rising`).map((n) => n.userId).sort()).toEqual(["u-admin", "u-staff", "u-staff2"]); // not the disabled account
    advance(45 * 60_000);
    await runOnce(radar);
    expect(db.notifications.filter((n) => n.dedupeKey.startsWith(`trend:${pitching.id}`))).toHaveLength(3);
    const mine = await notifications.list("u-staff");
    expect(mine.unread).toBe(1);
    expect(mine.items[0]).toMatchObject({ link: `/trend-radar?cluster=${pitching.id}`, title: expect.stringContaining("Rising") });
    expect(await notifications.markRead("u-staff", mine.items[0]!.id)).toBe(true);
    expect(await notifications.markRead("u-admin", mine.items[0]!.id)).toBe(false); // someone else's
    expect((await notifications.list("u-staff")).unread).toBe(0);
    expect((await notifications.list("u-admin")).unread).toBe(1);
  });

  it("Gemini: auto analysis only for Hot topics and at most the daily auto cap; manual until the total cap; one call each", async () => {
    generate.fn.mockImplementation(async () => ({ output: { titleJa: "快投", titleVi: "Ném bóng xuất sắc", summaryVi: "Theo tiêu đề...", summaryJa: "見出しによると…", mainTopic: "快投", category: "sports", whyInteresting: "x", facts: ["架空投手が快投"], angles: [{ title: "A", approach: "a" }, { title: "B", approach: "b" }, { title: "C", approach: "c" }], hooksJa: ["1", "2", "3"], suggestedTitleJa: "t", captionJa: "c", hashtags: ["野球"], reliability: { level: "medium", reason: "Chỉ có tiêu đề" }, warnings: [], dataNote: "Chỉ có tiêu đề" } }));
    const { config, radar, db } = setup();
    await config.update({ yahooEnabled: true, yahooCategories: ["sports", "entertainment"], thresholds: { hot: 20, rising: 15, review: 10 }, autoAnalysisPerDay: 1, analysisPerDay: 2 }, "u-admin");
    const run = (await runOnce(radar)).run!;
    expect(db.clusters.filter((cluster) => cluster.band === "hot")).toHaveLength(2);
    expect(run.analysedCount).toBe(1); // auto cap
    expect(generate.fn).toHaveBeenCalledTimes(1);
    expect(generate.fn.mock.calls[0]![4]).toBeUndefined(); // no response schema: one request, nothing for Gemini to reject
    const pending = db.clusters.find((cluster) => cluster.analysisStatus !== "done")!;
    expect(pending.analysisStatus).toBe("limit");
    expect((await radar.analyze(pending.id))!.status).toBe("done"); // manual still allowed under the total cap
    const other = db.clusters.find((cluster) => cluster.id !== pending.id)!;
    other.analysisStatus = "none";
    expect(await radar.analyze(other.id)).toMatchObject({ status: "limit", message: expect.stringContaining("hết 2 lần") });
    expect(generate.fn).toHaveBeenCalledTimes(2);
    expect(db.usage.reduce((sum, row) => sum + row.calls, 0)).toBe(2);
  });

  it("Gemini quota: the model is benched with the provider's retry time, the topic keeps its data and says when to retry", async () => {
    generate.fn.mockRejectedValue(new ProviderError("PROVIDER_QUOTA_EXHAUSTED", "RESOURCE_EXHAUSTED", false, 3_600_000, "daily"));
    const { config, radar, db, accounts } = setup();
    await config.update({ yahooEnabled: true, yahooCategories: ["sports"] }, "u-admin");
    await runOnce(radar);
    const cluster = db.clusters[0]!;
    const outcome = (await radar.analyze(cluster.id))!;
    expect(outcome).toMatchObject({ status: "quota", retryAt: new Date(NOW.getTime() + 3_600_000).toISOString() });
    expect(accounts.markModelLimited).toHaveBeenCalledWith("gem-1", "gemini-2.5-flash", 3_600_000, "RESOURCE_EXHAUSTED", expect.any(Date));
    expect(outcome.cluster.items.length).toBeGreaterThan(0);
    expect(db.usage[0]).toMatchObject({ calls: 1, failures: 1 });
    accounts.getModelAvailability.mockResolvedValueOnce({ available: false, retryAt: new Date(NOW.getTime() + 3_600_000) } as never);
    expect((await radar.analyze(cluster.id))!).toMatchObject({ status: "quota" });
    expect(generate.fn).toHaveBeenCalledTimes(1); // benched: no second call
  });

  it("no content account configured or shared -> analysis not configured, nothing called", async () => {
    const { config, radar, db } = setup();
    db.accounts.splice(db.accounts.findIndex((account) => account.id === "gem-1"), 1);
    await config.update({ yahooEnabled: true, yahooCategories: ["sports"] }, "u-admin");
    await runOnce(radar);
    expect((await radar.analyze(db.clusters[0]!.id))!.status).toBe("not_configured");
    expect(generate.fn).not.toHaveBeenCalled();
  });

  it("TikTok with real metrics (fixtures): metrics kept as returned, growth only from the second measurement of the same video", async () => {
    let views = 200_000;
    const runner: TikTokTrendRunner = async () => ({ runId: "r", items: [actorItem("7412345678901234567", "新作アニメの放送日が決定 #アニメ", views)] });
    const { config, radar, advance, db } = setup({ tiktok: runner });
    await config.update({ tiktokEnabled: true, tiktokAccountId: "apify-1", keywords: ["アニメ"] }, "u-admin");
    await runOnce(radar);
    const cluster = db.clusters[0]!;
    let detail = (await radar.clusterDetail(cluster.id))!;
    expect(detail.metrics).toMatchObject({ views: 200_000, likes: 12_000, comments: 300, shares: 500 });
    expect(detail.components.find((component) => component.key === "momentum")!.points).toBe(0);
    expect(detail.notes.join(" ")).toContain("mới có một lần đo");
    views = 260_000;
    advance(60 * 60_000);
    await runOnce(radar);
    detail = (await radar.clusterDetail(cluster.id))!;
    expect(detail.components.find((component) => component.key === "momentum")).toMatchObject({ points: 14, reason: expect.stringContaining("60.0K/giờ") });
  });

  it("manual TikTok URL: oEmbed fields only (no metrics); oEmbed failure keeps the URL with a clear warning; other sites refused", async () => {
    const { radar, db } = setup({ feeds: { oembed: () => respond(200, JSON.stringify({ title: "手作りアニメ #アニメ", author_name: "maker", author_url: "https://www.tiktok.com/@maker", thumbnail_url: "https://p16.tiktokcdn.com/x.jpg" })) } });
    const imported = await radar.importUrl("https://www.tiktok.com/@maker/video/7400000000000000001?is_from_webapp=1", "u-staff");
    expect(imported).toMatchObject({ created: true, warning: null, cluster: { metrics: null, items: [expect.objectContaining({ provider: "manual", author: "@maker", completeness: "embed_metadata", metrics: null })] } });
    expect(await radar.importUrl("https://www.tiktok.com/@maker/video/7400000000000000001", "u-staff")).toMatchObject({ created: false, warning: "URL này đã có trong Trend Radar" });
    const failing = setup({ feeds: {} });
    const kept = await failing.radar.importUrl("https://www.tiktok.com/@gone/video/7400000000000000002", "u-staff");
    expect(kept).toMatchObject({ created: true, warning: expect.stringContaining("không lấy được thông tin từ TikTok"), cluster: { items: [expect.objectContaining({ completeness: "user_supplied", url: "https://www.tiktok.com/@gone/video/7400000000000000002" })] } });
    expect(await failing.radar.importUrl("https://example.com/news/1", "u-staff")).toEqual({ error: expect.stringContaining("chỉ nhập được URL video TikTok") });
    expect(db.items).toHaveLength(1);
  });

  it("before a video: earlier jobs on the same story are found; several people get assigned with angles; the video link marks the topic used", async () => {
    const { config, radar, db } = setup();
    await config.update({ yahooEnabled: true, yahooCategories: ["sports"] }, "u-admin");
    await runOnce(radar);
    const cluster = db.clusters.find((entry) => entry.title.includes("快投"))!;
    db.jobs.push({ id: "job-1", topic: "架空投手が7回1失点の快投!\n続報", createdAt: new Date(NOW.getTime() - 86_400_000) }, { id: "job-2", topic: "全く別の話題", createdAt: new Date(NOW.getTime() - 86_400_000) });
    expect(await radar.duplicates(cluster.id)).toEqual([expect.objectContaining({ kind: "job", id: "job-1", reason: "similar_title", link: "/jobs/job-1" })]);

    expect(await radar.assign(cluster.id, { userId: "u-staff2" }, { id: "u-staff", role: "staff" })).toBe("forbidden");
    await radar.assign(cluster.id, { angleIndex: 0, angleTitle: "Tóm tắt" }, { id: "u-staff", role: "staff" });
    const assigned = await radar.assign(cluster.id, { userId: "u-staff2", angleIndex: 1 }, { id: "u-admin", role: "admin" });
    expect(assigned).toMatchObject({ assignments: [expect.objectContaining({ userId: "u-staff", angleIndex: 0 }), expect.objectContaining({ userId: "u-staff2", angleIndex: 1 })] });
    expect((await radar.listClusters({ assigneeId: "u-staff2" })).items.map((item) => item.id)).toEqual([cluster.id]);
    // only the hand-over by someone else notifies, once per topic + angle
    await radar.assign(cluster.id, { userId: "u-staff2", angleIndex: 1 }, { id: "u-admin", role: "admin" });
    expect(db.notifications.filter((n) => n.kind === "trend_assignment").map((n) => [n.userId, n.dedupeKey])).toEqual([["u-staff2", `trend-assign:${cluster.id}:1`]]);

    const linked = await radar.linkProduction(cluster.id, { kind: "video_production", productionId: "run-9", angleIndex: 1 }, "u-staff2");
    expect(linked).toMatchObject({ status: "used", productionRefs: [expect.objectContaining({ kind: "video_production", id: "run-9", angleIndex: 1 })] });
    expect(await radar.linkProduction(cluster.id, { kind: "nope", productionId: "x" }, "u-staff2")).toBe("invalid");
  });

  it("list filters: provider, band, status, keyword; status actions", async () => {
    const { config, radar, db } = setup();
    await config.update({ yahooEnabled: true, yahooCategories: ["sports", "entertainment"] }, "u-admin");
    await runOnce(radar);
    const pitching = db.clusters.find((cluster) => cluster.title.includes("快投"))!;
    expect((await radar.listClusters({ q: "チケット" })).items.map((item) => item.title)).toEqual([expect.stringContaining("チケット")]);
    expect((await radar.listClusters({ provider: "tiktok" })).total).toBe(0);
    await radar.updateCluster(pitching.id, { status: "rejected" }, "u-staff");
    expect((await radar.listClusters({ status: "rejected" })).items.map((item) => item.id)).toEqual([pitching.id]);
    expect(await radar.updateCluster(pitching.id, { status: "deleted" }, "u-staff")).toBe("invalid");
    await radar.updateCluster(pitching.id, { saved: true }, "u-staff");
    expect((await radar.listClusters({ saved: true })).total).toBe(1);
  });
});
