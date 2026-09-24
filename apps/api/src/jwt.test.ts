import { afterEach, describe, expect, it } from "vitest";
import { issueTokens, signJwt, verifyJwt } from "./jwt.js";

afterEach(() => {
  delete process.env.JWT_ACCESS_TTL_SEC;
});

describe("jwt HS256", () => {
  it("signs and verifies access and refresh tokens bound to a session", () => {
    const tokens = issueTokens("user-1", "sess-1");
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.expiresIn).toBe(900);
    const access = verifyJwt(tokens.accessToken);
    const refresh = verifyJwt(tokens.refreshToken);
    expect(access).toMatchObject({ typ: "access", sub: "user-1", sid: "sess-1" });
    expect(refresh).toMatchObject({ typ: "refresh", sub: "user-1", sid: "sess-1" });
    expect(refresh && refresh.exp - refresh.iat).toBeGreaterThan(access!.exp - access!.iat);
  });

  it("rejects a tampered signature and an expired token", () => {
    const token = signJwt("access", "user-1", "sess-1", 60);
    expect(verifyJwt(`${token}x`)).toBeNull();
    process.env.JWT_ACCESS_TTL_SEC = "1";
    const expired = signJwt("access", "user-1", "sess-1", -10);
    expect(verifyJwt(expired)).toBeNull();
  });
});
