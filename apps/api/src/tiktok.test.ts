import { describe, expect, it } from "vitest";
import { parseTiktokTokenResponse, parseTiktokUser, parseTiktokVideoTotals, tiktokCodeChallenge, buildTiktokAuthorizeUrl, tiktokRedirectUri } from "./tiktok.js";

describe("TikTok response parsers", () => {
  it("reads a flat token payload", () => {
    expect(parseTiktokTokenResponse({ access_token: "act", open_id: "oid", scope: "user.info.basic,video.list", expires_in: 60, refresh_token: "rft" })).toMatchObject({
      accessToken: "act", openId: "oid", refreshToken: "rft", scope: ["user.info.basic", "video.list"],
    });
  });

  it("reads a nested data token payload and rejects missing tokens", () => {
    expect(parseTiktokTokenResponse({ data: { access_token: "act", open_id: "oid" } })?.openId).toBe("oid");
    expect(parseTiktokTokenResponse({ error: "invalid_grant" })).toBeNull();
  });

  it("reads a user profile without exposing tokens", () => {
    expect(parseTiktokUser({ data: { user: { open_id: "oid", display_name: "Studio", avatar_url: "https://example.com/a.png" } } })).toEqual({
      openId: "oid",
      displayName: "Studio",
      username: null,
      avatarUrl: "https://example.com/a.png",
      followerCount: null,
      followingCount: null,
      likesCount: null,
      videoCount: null,
    });
  });

  it("reads channel stats from user.info.stats fields", () => {
    expect(parseTiktokUser({
      data: { user: { open_id: "oid", display_name: "Studio", follower_count: 12, likes_count: 40, video_count: 3 } },
      error: { code: "ok", message: "" },
    })).toMatchObject({ followerCount: 12, likesCount: 40, videoCount: 3 });
  });

  it("splits TikTok scopes on spaces or commas", () => {
    expect(parseTiktokTokenResponse({ access_token: "act", open_id: "oid", scope: "user.info.basic video.list" })?.scope).toEqual(["user.info.basic", "video.list"]);
  });

  it("rejects TikTok API error envelopes", () => {
    expect(parseTiktokUser({ error: { code: "scope_not_authorized", message: "missing" } })).toBeNull();
    expect(parseTiktokVideoTotals({ error: { code: "access_token_invalid" } })).toBeNull();
  });

  it("sums video metrics", () => {
    expect(parseTiktokVideoTotals({ data: { videos: [{ view_count: 10, like_count: 2, comment_count: 1, share_count: 0 }, { view_count: 5, like_count: 1, comment_count: 0, share_count: 3 }] } })).toEqual({
      views: 15, likes: 3, comments: 1, shares: 3, sampleCount: 2,
    });
  });

  it("uses TikTok hex SHA-256 for PKCE, not RFC 7636 base64url", () => {
    expect(tiktokCodeChallenge("test")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });

  it("keeps desktop redirect_uri unencoded in the authorize URL", () => {
    const url = buildTiktokAuthorizeUrl({
      clientKey: "sb_test",
      redirectUri: "http://localhost:5173/callback/",
      scope: "user.info.basic,video.list",
      state: "abc",
      codeChallenge: "deadbeef",
    });
    expect(url).toContain("redirect_uri=http://localhost:5173/callback/");
    expect(url).not.toContain("redirect_uri=http%3A%2F%2F");
  });

  it("ignores stale API callback URIs from .env.local", () => {
    const previous = process.env.TIKTOK_REDIRECT_URI;
    process.env.TIKTOK_REDIRECT_URI = "http://localhost:3000/api/v1/channel-oauth/tiktok/callback";
    expect(tiktokRedirectUri()).toBe("http://localhost:5173/callback/");
    process.env.TIKTOK_REDIRECT_URI = previous;
  });
});
