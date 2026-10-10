import { describe, expect, it } from "vitest";
import { SYSTEM_CREATION_DEFAULTS } from "@lyonix/domain/creation-form";
import { composeNewsTopic, serializeSelectedNews, type NewsItem } from "@lyonix/domain/news";
import { trendIntent, trendPick } from "./trend-pick";

const TOPIC = "架空投手、7回1失点\n\nAngle: Con số - 3 con số\n\nSource: スポーツ報知 - https://news.yahoo.co.jp/articles/abc";

describe("VE2E-158 create-video page from Trend Radar", () => {
  it("reads ?trend=&angle= (a bad id or angle is ignored, never guessed)", () => {
    expect(trendIntent(new URLSearchParams("entry=auto&trend=7c0e1f6a-1111-4222-8333-944445555666&angle=1"))).toEqual({ clusterId: "7c0e1f6a-1111-4222-8333-944445555666", angleIndex: 1 });
    expect(trendIntent(new URLSearchParams("trend=c1"))).toEqual({ clusterId: "c1", angleIndex: null });
    expect(trendIntent(new URLSearchParams("trend=c1&angle=x"))).toEqual({ clusterId: "c1", angleIndex: null });
    expect(trendIntent(new URLSearchParams("trend=../../etc"))).toBeNull();
    expect(trendIntent(new URLSearchParams("entry=auto"))).toBeNull();
  });

  it("fills the topic, a topic source and a Japanese script; Auto and manual both", () => {
    const auto = trendPick({ ...SYSTEM_CREATION_DEFAULTS, entryMode: "auto", topic: "" }, TOPIC);
    expect(auto).toEqual({ kind: "apply", needsConfirm: false, patch: { topic: TOPIC, selectedNews: "", language: "ja", autoSourceType: "topic" } });
    const manual = trendPick({ ...SYSTEM_CREATION_DEFAULTS, entryMode: "manual", topic: "" }, TOPIC);
    expect(manual).toMatchObject({ kind: "apply", patch: { mode: "topic", language: "ja" } });
    expect(trendPick({ ...SYSTEM_CREATION_DEFAULTS, topic: `${TOPIC}\n` }, TOPIC)).toEqual({ kind: "same" });
  });

  it("a topic the user typed is only replaced after a confirm; one made from a picked news item is not asked about", () => {
    expect(trendPick({ ...SYSTEM_CREATION_DEFAULTS, topic: "chủ đề tự gõ" }, TOPIC)).toMatchObject({ kind: "apply", needsConfirm: true });
    const news: NewsItem = { id: "yahoo_jp:1", sourceId: "yahoo_jp", source: "Yahoo!ニュース", publisher: "スポーツ報知", category: "sports", title: "見出し", excerpt: "要約", thumbnailUrl: null, sourceUrl: "https://news.yahoo.co.jp/pickup/1", publishedAt: null };
    const fromNews = { ...SYSTEM_CREATION_DEFAULTS, topic: composeNewsTopic(news), selectedNews: serializeSelectedNews(news) };
    expect(trendPick(fromNews, TOPIC)).toMatchObject({ kind: "apply", needsConfirm: false, patch: { selectedNews: "" } });
  });
});
