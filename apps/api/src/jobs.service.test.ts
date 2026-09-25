import { describe, expect, it } from "vitest";
import { isSwitchableProviderError, noticeAfterApprove, noticeAfterGenerate, noticeSuggestSwitch, splitTopicSource } from "./jobs.service.js";

describe("script workflow notices", () => {
  it("emits an approve notice that leaves scripting", () => {
    expect(noticeAfterApprove(3)).toContain("v3");
    expect(noticeAfterApprove(3)).toContain("cảnh");
  });

  it("names the content provider in the generate notice", () => {
    expect(noticeAfterGenerate("openai", "gpt-4o-mini", 2, "req_1")).toContain("openai");
    expect(noticeAfterGenerate("openai", "gpt-4o-mini", 2, "req_1")).toContain("v2");
    expect(noticeAfterGenerate("openai", "gpt-4o-mini", 2, "req_1")).toContain("req_1");
  });

  it("asks the user to switch content account after quota or rate-limit", () => {
    expect(isSwitchableProviderError("PROVIDER_RATE_LIMITED")).toBe(true);
    expect(isSwitchableProviderError("PROVIDER_QUOTA_EXHAUSTED")).toBe(true);
    expect(isSwitchableProviderError("PROVIDER_SCHEMA_INVALID")).toBe(false);
    expect(noticeSuggestSwitch("openai", "gpt-5", "PROVIDER_RATE_LIMITED: no credits")).toContain("Đổi tài khoản");
  });

  it("keeps a short topic and moves a long transcript to source", () => {
    const long = "A ".repeat(200);
    const split = splitTopicSource(long);
    expect(split.topic.length).toBeLessThanOrEqual(80);
    expect(split.source.length).toBeGreaterThan(200);
  });
});
