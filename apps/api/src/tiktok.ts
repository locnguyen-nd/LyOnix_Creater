import { createHash, randomBytes } from "node:crypto";

export type TiktokTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  openId: string;
  scope: string[];
  expiresAt: number | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const splitTiktokScopes = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((item) => splitTiktokScopes(item));
  if (typeof value !== "string") return [];
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
};

export const hasTiktokScope = (scopes: string[], needed: string) => splitTiktokScopes(scopes).includes(needed);

export const parseTiktokTokenResponse = (body: unknown): TiktokTokenSet | null => {
  const root = asRecord(body);
  if (!root) return null;
  const error = asRecord(root.error);
  const errorCode = typeof error?.code === "string" ? error.code : typeof root.error === "string" ? root.error : null;
  if (errorCode && errorCode !== "ok") return null;
  const nested = asRecord(root.data);
  const payload = nested && typeof nested.access_token === "string" ? nested : root;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  const openId = typeof payload.open_id === "string" ? payload.open_id : null;
  if (!accessToken || !openId) return null;
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    openId,
    scope: splitTiktokScopes(payload.scope),
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
  };
};

export const TIKTOK_USER_BASIC_FIELDS = "open_id,union_id,avatar_url,avatar_url_100,display_name";
export const TIKTOK_USER_STATS_FIELDS = `${TIKTOK_USER_BASIC_FIELDS},follower_count,following_count,likes_count,video_count`;
export const tiktokUserFields = TIKTOK_USER_BASIC_FIELDS;

export type TiktokUser = {
  openId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  followerCount: number | null;
  followingCount: number | null;
  likesCount: number | null;
  videoCount: number | null;
};

const asCount = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const tiktokApiError = (body: unknown) => {
  const root = asRecord(body);
  const error = asRecord(root?.error);
  const code = typeof error?.code === "string" ? error.code : typeof root?.error === "string" ? root.error : null;
  if (!code || code === "ok") return null;
  const message = typeof error?.message === "string" ? error.message : code;
  return { code, message };
};

export const parseTiktokUser = (body: unknown): TiktokUser | null => {
  if (tiktokApiError(body)) return null;
  const root = asRecord(body);
  const data = asRecord(root?.data);
  const user = asRecord(data?.user) ?? data;
  const openId = typeof user?.open_id === "string" ? user.open_id : null;
  if (!openId) return null;
  const displayName = typeof user?.display_name === "string" && user.display_name.trim() ? user.display_name.trim() : null;
  const username = typeof user?.username === "string" && user.username.trim() ? user.username.trim() : null;
  const avatar = typeof user?.avatar_url_100 === "string" ? user.avatar_url_100 : typeof user?.avatar_url === "string" ? user.avatar_url : null;
  return {
    openId,
    displayName: displayName || username || openId,
    username,
    avatarUrl: avatar,
    followerCount: asCount(user?.follower_count),
    followingCount: asCount(user?.following_count),
    likesCount: asCount(user?.likes_count),
    videoCount: asCount(user?.video_count),
  };
};

export const refreshTiktokToken = async (refreshToken: string): Promise<TiktokTokenSet | null> => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  if (!clientKey || !clientSecret) return null;
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  return parseTiktokTokenResponse(await response.json().catch(() => null));
};

export const parseTiktokVideoTotals = (body: unknown): { views: number; likes: number; comments: number; shares: number; sampleCount: number } | null => {
  if (tiktokApiError(body)) return null;
  const root = asRecord(body);
  const data = asRecord(root?.data);
  const videos = (data?.videos ?? root?.videos) as Array<Record<string, unknown>> | undefined;
  const list = Array.isArray(videos) ? videos : [];
  let views = 0; let likes = 0; let comments = 0; let shares = 0;
  for (const video of list) {
    views += Number(video.view_count ?? 0);
    likes += Number(video.like_count ?? 0);
    comments += Number(video.comment_count ?? 0);
    shares += Number(video.share_count ?? 0);
  }
  return { views, likes, comments, shares, sampleCount: list.length };
};

const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** TikTok desktop/web localhost requires hex SHA-256, not RFC 7636 base64url. */
export const tiktokCodeChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("hex");

export const createTiktokPkce = () => {
  const verifier = Array.from(randomBytes(64), (byte) => PKCE_CHARS[byte % PKCE_CHARS.length] ?? "A").join("");
  return { verifier, challenge: tiktokCodeChallenge(verifier) };
};

export const DEFAULT_TIKTOK_REDIRECT_URI = "http://localhost:5173/callback/";
export const DEFAULT_TIKTOK_SCOPES = "user.info.basic,user.info.profile,user.info.stats,video.list";

export const tiktokRedirectUri = () => {
  const fromEnv = process.env.TIKTOK_REDIRECT_URI?.trim();
  if (!fromEnv || fromEnv.includes("/api/") || fromEnv.includes(":3000")) return DEFAULT_TIKTOK_REDIRECT_URI;
  return fromEnv;
};
export const tiktokScopes = () => process.env.TIKTOK_SCOPES?.trim() || DEFAULT_TIKTOK_SCOPES;

/** TikTok Desktop sample concatenates redirect_uri unencoded; URLSearchParams encoding fails sandbox matching. */
export const buildTiktokAuthorizeUrl = (input: { clientKey: string; redirectUri: string; scope: string; state: string; codeChallenge: string }) =>
  `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(input.clientKey)}&response_type=code&scope=${encodeURIComponent(input.scope)}&redirect_uri=${input.redirectUri}&state=${encodeURIComponent(input.state)}&code_challenge=${encodeURIComponent(input.codeChallenge)}&code_challenge_method=S256`;
