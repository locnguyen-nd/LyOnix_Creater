import { createHmac, timingSafeEqual } from "node:crypto";

export type JwtTyp = "access" | "refresh";
export type JwtPayload = { typ: JwtTyp; sub: string; sid: string; iat: number; exp: number };

const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export const jwtSecret = () => {
  const secret = process.env.JWT_SECRET?.trim();
  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error("JWT_SECRET is required in production");
  }
  return secret || "lyonix-dev-jwt";
};

export const accessTtlSec = () => {
  const n = Number(process.env.JWT_ACCESS_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 900;
};

export const refreshTtlSec = () => {
  const n = Number(process.env.JWT_REFRESH_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 2_592_000;
};

export const signJwt = (typ: JwtTyp, sub: string, sid: string, ttlSec: number) => {
  const iat = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = { typ, sub, sid, iat, exp: iat + ttlSec };
  const mid = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${mid}`;
  const sig = createHmac("sha256", jwtSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
};

export const verifyJwt = (token: string | undefined): JwtPayload | null => {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;
  const unsigned = `${h}.${p}`;
  const expected = createHmac("sha256", jwtSecret()).update(unsigned).digest("base64url");
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.typ !== "access" && payload.typ !== "refresh") return null;
    if (!payload.sub || !payload.sid) return null;
    return payload;
  } catch {
    return null;
  }
};

export const issueTokens = (userId: string, sessionId: string) => {
  const expiresIn = accessTtlSec();
  return {
    tokenType: "Bearer" as const,
    expiresIn,
    accessToken: signJwt("access", userId, sessionId, expiresIn),
    refreshToken: signJwt("refresh", userId, sessionId, refreshTtlSec()),
  };
};
