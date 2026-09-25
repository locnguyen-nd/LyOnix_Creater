import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { ChannelsService } from "./channels.service.js";
import { parseTiktokTokenResponse, createTiktokPkce, buildTiktokAuthorizeUrl, tiktokRedirectUri, tiktokScopes } from "./tiktok.js";

type Pending = { userId: string; expiresAt: number; codeVerifier: string };

@Injectable()
export class TiktokOauthService {
  private readonly pending = new Map<string, Pending>();
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  configured() {
    const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
    return Boolean(clientKey && clientSecret && tiktokRedirectUri());
  }

  publicConfig() {
    return {
      configured: this.configured(),
      redirectUri: tiktokRedirectUri(),
      scopes: tiktokScopes().split(","),
    };
  }

  begin(userId: string) {
    const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
    const redirectUri = tiktokRedirectUri();
    if (!this.configured() || !clientKey) return null;
    const state = randomBytes(32).toString("base64url");
    const pkce = createTiktokPkce();
    this.pending.set(state, { userId, expiresAt: Date.now() + 10 * 60 * 1000, codeVerifier: pkce.verifier });
    return buildTiktokAuthorizeUrl({
      clientKey,
      redirectUri,
      scope: tiktokScopes(),
      state,
      codeChallenge: pkce.challenge,
    });
  }

  async complete(code: string, state: string) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim();
    const redirectUri = tiktokRedirectUri();
    if (!pending || pending.expiresAt < Date.now() || !clientKey || !clientSecret || !redirectUri) return null;
    const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: pending.codeVerifier,
      }),
    });
    const body = await response.json().catch(() => null);
    const tokens = parseTiktokTokenResponse(body);
    if (!tokens) return null;
    const profile = await this.channels.lookupUser(tokens.accessToken);
    const row = await this.channels.upsertConnection({
      userId: pending.userId,
      openId: tokens.openId,
      displayName: profile?.displayName ?? tokens.openId,
      username: profile?.username ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      authType: "oauth2",
      tokens,
    });
    await this.channels.sync(row.id, pending.userId, "admin");
    return {
      channelId: row.id,
      openId: tokens.openId,
      scopes: tokens.scope,
      connectionFingerprint: createHash("sha256").update(`${pending.userId}:${tokens.openId}`).digest("hex"),
    };
  }
}
