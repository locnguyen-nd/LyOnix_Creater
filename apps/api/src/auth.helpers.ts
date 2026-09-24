import type { Request, Response } from "express";
import { HttpStatus } from "@nestjs/common";
import { normalizedError } from "./envelopes.js";
import type { AuthService, DemoUser, Session } from "./auth.service.js";
import { accessTtlSec, issueTokens, refreshTtlSec, verifyJwt } from "./jwt.js";

const ACCESS = "lyonix_access";
const REFRESH = "lyonix_refresh";
const LEGACY = "lyonix_session";

const cookieBase = () => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
});

export const requestId = (response: Response) => response.locals.requestId ?? "unknown";

export const cookieValue = (request: Request, name: string) => {
  const raw = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const bearerToken = (request: Request) => {
  const header = request.header("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
};

const sessionFromPayload = async (auth: AuthService, token: string | undefined, typ: "access" | "refresh") => {
  const payload = verifyJwt(token);
  if (!payload || payload.typ !== typ) return null;
  const session = await auth.getSession(payload.sid);
  if (!session || session.userId !== payload.sub) return null;
  return session;
};

export const currentSession = async (request: Request, auth: AuthService) =>
  await sessionFromPayload(auth, cookieValue(request, ACCESS) ?? bearerToken(request), "access")
  ?? await sessionFromPayload(auth, cookieValue(request, REFRESH), "refresh")
  ?? await auth.getSession(cookieValue(request, LEGACY));

export const setAuthCookies = (response: Response, tokens: ReturnType<typeof issueTokens>) => {
  response.cookie(ACCESS, tokens.accessToken, { ...cookieBase(), maxAge: accessTtlSec() * 1000 });
  response.cookie(REFRESH, tokens.refreshToken, { ...cookieBase(), maxAge: refreshTtlSec() * 1000 });
  response.clearCookie(LEGACY, cookieBase());
};

export const clearAuthCookies = (response: Response) => {
  response.clearCookie(ACCESS, cookieBase());
  response.clearCookie(REFRESH, cookieBase());
  response.clearCookie(LEGACY, cookieBase());
};

export const attachSessionTokens = (response: Response, session: Session) => {
  const tokens = issueTokens(session.userId, session.id);
  setAuthCookies(response, tokens);
  return tokens;
};

export const requireUser = async (request: Request, response: Response, auth: AuthService): Promise<{ user: DemoUser; session: Session }> => {
  let session = await sessionFromPayload(auth, cookieValue(request, ACCESS) ?? bearerToken(request), "access");
  if (!session) {
    session = await sessionFromPayload(auth, cookieValue(request, REFRESH), "refresh");
    if (session) attachSessionTokens(response, session);
  }
  if (!session) {
    session = await auth.getSession(cookieValue(request, LEGACY));
    if (session) attachSessionTokens(response, session);
  }
  const user = session && await auth.getUser(session.userId);
  if (!session || !user) throw normalizedError("UNAUTHENTICATED", "Chưa đăng nhập", requestId(response), HttpStatus.UNAUTHORIZED);
  return { user, session };
};

export const requireCsrf = (request: Request, response: Response, session: Session) => {
  const token = request.header("x-csrf-token");
  if (!token || token.length !== session.csrfToken.length || token !== session.csrfToken) {
    throw normalizedError("FORBIDDEN", "CSRF token không hợp lệ", requestId(response), HttpStatus.FORBIDDEN);
  }
};
