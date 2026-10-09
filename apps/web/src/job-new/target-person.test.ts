import { describe, expect, it } from "vitest";
import { serializeSelectedNews } from "@lyonix/domain/news";
import { targetPersonSubmitFields, targetPersonSummary, withTargetPersonDirection } from "./target-person";

const news = serializeSelectedNews({ id: "yahoo_jp:1", sourceId: "yahoo_jp", source: "Yahoo!ニュース", publisher: null, title: "Stray Kidsフィリックス、活動再開", excerpt: "ソロ曲も披露", thumbnailUrl: null, sourceUrl: "https://news.yahoo.co.jp/a/1", publishedAt: null, category: "entertainment" } as never);

describe("VE2E-151 target person field", () => {
  it("Auto submit sends the typed person and the selected news text; nothing when both are empty", () => {
    expect(targetPersonSubmitFields({ targetPerson: " Lee Felix / フィリックス (Stray Kids) ", selectedNews: news })).toEqual({ targetPerson: "Lee Felix / フィリックス (Stray Kids)", newsContext: "Stray Kidsフィリックス、活動再開 ソロ曲も披露" });
    expect(targetPersonSubmitFields({ targetPerson: "", selectedNews: "" })).toEqual({});
  });

  it("summary row and the manual direction line", () => {
    expect(targetPersonSummary("Lee Felix / フィリックス (Stray Kids)")).toBe("Lee Felix · フィリックス (Stray Kids)");
    expect(targetPersonSummary("  ")).toBeNull();
    expect(withTargetPersonDirection("Short 45s", "Lee Felix (Stray Kids)")).toBe("Short 45s\nTarget person (chosen by the user, highest priority): Lee Felix (Stray Kids). The whole script is about Lee Felix; mention other people only as direct context.");
    expect(withTargetPersonDirection("Short 45s", "")).toBe("Short 45s");
  });
});
