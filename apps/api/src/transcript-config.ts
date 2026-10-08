/**
 * VE2E-96: which transcript providers the URL intake uses for a given user - never chosen by the UI, keys never leave the server:
 *  - TikTok subtitles + video file: the user's verified, enabled Apify account in Provider Settings (the form's media account first),
 *    else the environment (TIKTOK_APIFY_TOKEN);
 *  - speech-to-text (only when a video has no subtitle): the user's verified ElevenLabs account (the form's voice account first),
 *    else the environment (ELEVENLABS_STT_API_KEY; ELEVENLABS_STT_MODEL optional).
 * `TIKTOK_SOURCE_PROVIDER=mock` / `STT_PROVIDER=mock` force the development stand-ins (they say "mock"). Nothing found = not configured.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ApifyTikTokTranscriptSource, ELEVENLABS_STT_DEFAULT_MODEL, ElevenLabsSpeechToText, MockSpeechToText, MockVideoTranscriptSource, type SpeechToTextProvider, type VideoTranscriptSource } from "@lyonix/providers";
import { ApifyService } from "./apify.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret } from "./secret-crypto.js";

export type TranscriptProviders = { video: VideoTranscriptSource | null; stt: SpeechToTextProvider | null };

/** Who asks (account visibility) and the accounts chosen on the form (preferred when usable). */
export type TranscriptContext = { userId: string; role: "admin" | "staff"; mediaAccountId?: string; voiceAccountId?: string };

export interface TranscriptResolver {
  video(context: TranscriptContext): Promise<VideoTranscriptSource | null>;
  stt(context: TranscriptContext): Promise<SpeechToTextProvider | null>;
}

type Env = Record<string, string | undefined>;
const sttModel = (env: Env) => (env.ELEVENLABS_STT_MODEL ?? "").trim() || ELEVENLABS_STT_DEFAULT_MODEL;

/** Environment-only providers (no account lookup): the fallback, and what tests / scripts use. */
export function transcriptProvidersFromEnv(env: Env = process.env): TranscriptProviders {
  const videoKind = (env.TIKTOK_SOURCE_PROVIDER ?? "").trim().toLowerCase();
  const sttKind = (env.STT_PROVIDER ?? "").trim().toLowerCase();
  const apifyToken = (env.TIKTOK_APIFY_TOKEN ?? "").trim();
  const sttKey = (env.ELEVENLABS_STT_API_KEY ?? "").trim();
  const video = videoKind === "mock" ? new MockVideoTranscriptSource() : apifyToken && (videoKind === "" || videoKind === "apify") ? new ApifyTikTokTranscriptSource(apifyToken) : null;
  const stt = sttKind === "mock" ? new MockSpeechToText() : sttKey && (sttKind === "" || sttKind === "elevenlabs") ? new ElevenLabsSpeechToText(sttKey, sttModel(env)) : null;
  return { video, stt };
}

export const TRANSCRIPT_ENV = "TRANSCRIPT_ENV";

@Injectable()
export class TranscriptProviderResolver implements TranscriptResolver {
  private readonly env: () => Env;

  constructor(
    @Inject(ApifyService) private readonly apify: Pick<ApifyService, "findAccountForUser" | "usableAccount">,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(TRANSCRIPT_ENV) env?: () => Env,
  ) {
    this.env = env ?? (() => process.env);
  }

  async video(context: TranscriptContext): Promise<VideoTranscriptSource | null> {
    const env = this.env();
    if ((env.TIKTOK_SOURCE_PROVIDER ?? "").trim().toLowerCase() === "mock") return new MockVideoTranscriptSource();
    const preferred = context.mediaAccountId ? await this.apify.usableAccount(context.mediaAccountId) : null;
    const account = preferred?.ok && (await this.visible(context, preferred.data.id)) ? preferred.data : await this.apify.findAccountForUser(context.userId, context.role);
    if (account) return new ApifyTikTokTranscriptSource(decryptSecret(account.encryptedSecret));
    return transcriptProvidersFromEnv(env).video;
  }

  async stt(context: TranscriptContext): Promise<SpeechToTextProvider | null> {
    const env = this.env();
    if ((env.STT_PROVIDER ?? "").trim().toLowerCase() === "mock") return new MockSpeechToText();
    const rows = await this.prisma.providerAccount.findMany({
      where: {
        provider: "elevenlabs",
        role: "tts",
        deletedAt: null,
        enabled: true,
        ...(process.env.NODE_ENV === "test" ? {} : { status: "verified", isFake: false }),
        ...(context.role === "admin" ? {} : { OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: context.userId }] }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, encryptedSecret: true },
    });
    const account = rows.find((row) => row.id === context.voiceAccountId) ?? rows[0];
    if (account) return new ElevenLabsSpeechToText(decryptSecret(account.encryptedSecret), sttModel(env));
    return transcriptProvidersFromEnv(env).stt;
  }

  /** The form's Apify account counts only when this user may see it (same rules as the provider list). */
  private async visible(context: TranscriptContext, accountId: string): Promise<boolean> {
    if (context.role === "admin") return true;
    const row = await this.prisma.providerAccount.findFirst({ where: { id: accountId, OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: context.userId }] }, select: { id: true } });
    return Boolean(row);
  }
}
