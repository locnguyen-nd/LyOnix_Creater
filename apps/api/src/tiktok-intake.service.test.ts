import { describe, expect, it, vi } from "vitest";
import { TranscriptError, type SpeechToTextProvider, type TikTokVideoInfo, type VideoTranscriptSource } from "@lyonix/providers";
import { TikTokIntakeService, resolveTikTokShortLink, type TikTokIntakeOptions } from "./tiktok-intake.service.js";
import type { fetchBinarySafely } from "./safe-binary-fetch.js";
import type { TranscriptContext } from "./transcript-config.js";

const CONTEXT: TranscriptContext = { userId: "u1", role: "staff", mediaAccountId: "apify-1", voiceAccountId: "el-1" };

const ID = "7412345678901234567";
const URL_VIDEO = `https://www.tiktok.com/@osaka.news/video/${ID}`;
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n大阪に新しい駅\n\n00:00:02.000 --> 00:00:04.000\n大阪に新しい駅ができます\n\n00:00:04.000 --> 00:00:06.000\n開業は2025年3月です\n";

const info = (over: Partial<TikTokVideoInfo> = {}): TikTokVideoInfo => ({
  videoId: ID,
  url: URL_VIDEO,
  author: "osaka.news",
  caption: "新駅を紹介 #osaka #train",
  durationSec: 30,
  language: "ja",
  subtitles: [{ language: "ja", download: { url: "https://api.apify.com/v2/key-value-stores/KV/records/sub.vtt", hostSuffixes: ["api.apify.com"], scopedHeaders: { host: "api.apify.com", headers: { Authorization: "Bearer t" } } } }],
  media: { url: "https://api.apify.com/v2/key-value-stores/KV/records/video.mp4", hostSuffixes: ["api.apify.com"], scopedHeaders: { host: "api.apify.com", headers: { Authorization: "Bearer t" } } },
  ...over,
});

const setup = (opts: { source?: Partial<VideoTranscriptSource> | null; stt?: Partial<SpeechToTextProvider> | null; files?: Record<string, string | null>; redirects?: Record<string, string> } = {}) => {
  const resolveTikTok = vi.fn(async (_url: string, _options: { language?: string | null; timeoutSecs: number }) => info());
  const source: VideoTranscriptSource | null = opts.source === null ? null : { id: "apify", resolveTikTok, ...opts.source };
  const transcribeAudio = vi.fn(async (_input: { audio: Uint8Array; mimeType: string; fileName: string; languageHint?: string | null }, _options: { timeoutMs: number }) => ({ text: "えー、大阪に新しい駅ができます。 開業は2025年3月です。", language: "jpn" as string | null }));
  const stt: SpeechToTextProvider | null = opts.stt === null ? null : { id: "elevenlabs_scribe", transcribeAudio, ...opts.stt };
  const files = opts.files ?? { "https://api.apify.com/v2/key-value-stores/KV/records/sub.vtt": VTT, "https://api.apify.com/v2/key-value-stores/KV/records/video.mp4": "VIDEOBYTES" };
  const download = vi.fn<typeof fetchBinarySafely>(async (url) => {
    const body = files[url];
    return body === null || body === undefined ? { ok: false, reason: "fetch_failed" } : { ok: true, buffer: Buffer.from(body), mimeType: url.endsWith(".mp4") ? "video/mp4" : "text/vtt", finalUrl: url };
  });
  const shortLinkFetch = vi.fn(async (url: string) => ({ status: opts.redirects?.[url] ? 301 : 200, headers: { get: (name: string) => (name === "location" ? opts.redirects?.[url] ?? null : null) } }));
  const options: TikTokIntakeOptions = { download, shortLinkFetch, sleep: async () => undefined };
  const resolver = { video: vi.fn(async (_context: TranscriptContext) => source), stt: vi.fn(async (_context: TranscriptContext) => stt) };
  const real = new TikTokIntakeService(resolver, options);
  const stages: string[] = [];
  const service = { read: (url: string) => real.read(url, { context: CONTEXT, onStage: (stage) => stages.push(stage) }) };
  return { service, resolver, stages, resolveTikTok, transcribeAudio, download, shortLinkFetch };
};

describe("VE2E-96 TikTok URL -> transcript", () => {
  it("subtitle: downloaded through the safe fetch (allow-listed host, token only to that host), cleaned, method subtitle", async () => {
    const { service, download, transcribeAudio } = setup();
    const result = await service.read(URL_VIDEO);
    expect(result).toMatchObject({
      ok: true,
      source: { sourceType: "tiktok", sourceUrl: URL_VIDEO, title: "新駅を紹介", sourceName: "TikTok · @osaka.news", cleanedText: "大阪に新しい駅ができます開業は2025年3月です", language: "ja", method: "subtitle", providerUsed: "apify" },
    });
    expect(download.mock.calls[0]![1]).toMatchObject({ allowedHostSuffixes: ["api.apify.com"], hostScopedHeaders: { host: "api.apify.com" }, maxBytes: 2_000_000 });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("no subtitle: falls back to speech-to-text on the video file (50 MB cap, video/audio only)", async () => {
    const { service, transcribeAudio, download } = setup({ source: { resolveTikTok: async () => info({ subtitles: [] }) } });
    const result = await service.read(URL_VIDEO);
    expect(result).toMatchObject({ ok: true, source: { method: "speech_to_text", providerUsed: "apify+elevenlabs_scribe", language: "ja", cleanedText: "えー、大阪に新しい駅ができます。開業は2025年3月です。" } });
    expect(download.mock.calls[0]![1]).toMatchObject({ maxBytes: 50 * 1024 * 1024, allowedMimePrefixes: ["video/", "audio/", "application/octet-stream", "binary/octet-stream"] });
    expect(transcribeAudio.mock.calls[0]![0]).toMatchObject({ mimeType: "video/mp4", fileName: `tiktok-${ID}.mp4`, languageHint: "ja" });
  });

  it("a subtitle that cannot be downloaded or is empty also falls back to speech-to-text", async () => {
    const { service, transcribeAudio } = setup({ files: { "https://api.apify.com/v2/key-value-stores/KV/records/sub.vtt": "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n[Music]\n", "https://api.apify.com/v2/key-value-stores/KV/records/video.mp4": "V" } });
    expect(await service.read(URL_VIDEO)).toMatchObject({ ok: true, source: { method: "speech_to_text" } });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it("short links vm. / vt. are resolved on TikTok hosts only", async () => {
    const { service, resolveTikTok } = setup({ redirects: { "https://vm.tiktok.com/ZMabc123/": URL_VIDEO } });
    expect(await service.read("https://vm.tiktok.com/ZMabc123/")).toMatchObject({ ok: true });
    expect(resolveTikTok.mock.calls[0]![0]).toBe(URL_VIDEO);
    const offHost = setup({ redirects: { "https://vt.tiktok.com/ZSxyz789/": "https://evil.example/@a/video/1" } });
    expect(await offHost.service.read("https://vt.tiktok.com/ZSxyz789/")).toMatchObject({ ok: false, code: "tiktok_resolve_failed" });
    expect(offHost.resolveTikTok).not.toHaveBeenCalled();
    const fetchImpl = vi.fn(async () => ({ status: 301, headers: { get: () => "http://127.0.0.1/@a/video/7412345678901234567" } }));
    expect(await resolveTikTokShortLink("https://vm.tiktok.com/ZMabc123/", fetchImpl)).toBeNull();
  });

  it("not a TikTok video link: invalid_tiktok_url, no provider call", async () => {
    const { service, resolveTikTok } = setup();
    for (const raw of ["https://www.tiktok.com/@osaka.news", "https://www.tiktok.com/@a/photo/7412345678901234567", "https://shop.tiktok.com/x"]) {
      expect(await service.read(raw), raw).toMatchObject({ ok: false, code: "invalid_tiktok_url" });
    }
    expect(resolveTikTok).not.toHaveBeenCalled();
  });

  it("providers not configured: says so, nothing faked", async () => {
    expect(await setup({ source: null }).service.read(URL_VIDEO)).toMatchObject({ ok: false, code: "transcript_provider_not_configured" });
    const noStt = setup({ stt: null, source: { resolveTikTok: async () => info({ subtitles: [] }) } });
    expect(await noStt.service.read(URL_VIDEO)).toMatchObject({ ok: false, code: "stt_provider_not_configured" });
  });

  it("timeout: retried once, then reported; not found / auth are not retried", async () => {
    const timeout = vi.fn(async () => { throw new TranscriptError("timeout", "slow", true); });
    const slow = setup({ source: { resolveTikTok: timeout } });
    expect(await slow.service.read(URL_VIDEO)).toMatchObject({ ok: false, code: "transcript_timeout" });
    expect(timeout).toHaveBeenCalledTimes(2);
    const missing = vi.fn(async () => { throw new TranscriptError("not_found", "gone"); });
    expect(await setup({ source: { resolveTikTok: missing } }).service.read(URL_VIDEO)).toMatchObject({ ok: false, code: "tiktok_not_found" });
    expect(missing).toHaveBeenCalledTimes(1);
    const sttDown = vi.fn(async () => { throw new TranscriptError("timeout", "slow", true); });
    const failedStt = setup({ source: { resolveTikTok: async () => info({ subtitles: [] }) }, stt: { transcribeAudio: sttDown } });
    expect(await failedStt.service.read(URL_VIDEO)).toMatchObject({ ok: false, code: "transcript_timeout" });
    expect(sttDown).toHaveBeenCalledTimes(2);
  });

  it("empty transcript and missing media are clear errors", async () => {
    const silent = setup({ source: { resolveTikTok: async () => info({ subtitles: [] }) }, stt: { transcribeAudio: async () => ({ text: "  [Music] ♪ ", language: null }) } });
    expect(await silent.service.read(URL_VIDEO)).toMatchObject({ ok: false, code: "transcript_empty" });
    const noMedia = setup({ source: { resolveTikTok: async () => info({ subtitles: [], media: null }) } });
    expect(await noMedia.service.read(URL_VIDEO)).toMatchObject({ ok: false, code: "media_unavailable" });
  });

  it("caches a result per video for 30 minutes (no second paid run)", async () => {
    const { service, resolveTikTok } = setup();
    await service.read(URL_VIDEO);
    await service.read(`${URL_VIDEO}?is_from_webapp=1`);
    expect(resolveTikTok).toHaveBeenCalledTimes(1);
  });
});

describe("TikTok intake with Provider Settings accounts", () => {
  it("a video with subtitles never looks up nor calls speech-to-text; stages: reading > subtitles", async () => {
    const { service, resolver, stages, transcribeAudio } = setup();
    expect(await service.read(URL_VIDEO)).toMatchObject({ ok: true, source: { method: "subtitle" } });
    expect(resolver.video).toHaveBeenCalledWith(CONTEXT);
    expect(resolver.stt).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(stages).toEqual(["reading", "subtitles"]);
  });

  it("no subtitle: the speech-to-text account is looked up only then; stages: reading > subtitles > speech", async () => {
    const { service, resolver, stages } = setup({ source: { resolveTikTok: async () => info({ subtitles: [] }) } });
    expect(await service.read(URL_VIDEO)).toMatchObject({ ok: true, source: { method: "speech_to_text" } });
    expect(resolver.stt).toHaveBeenCalledWith(CONTEXT);
    expect(stages).toEqual(["reading", "subtitles", "speech"]);
  });

  it("says exactly what is missing", async () => {
    expect(await setup({ source: null }).service.read(URL_VIDEO)).toEqual({ ok: false, code: "transcript_provider_not_configured", message: "Chưa cấu hình Apify. Vào Cài đặt > Provider để thêm tài khoản." });
    const noStt = setup({ stt: null, source: { resolveTikTok: async () => info({ subtitles: [] }) } });
    expect(await noStt.service.read(URL_VIDEO)).toEqual({ ok: false, code: "stt_provider_not_configured", message: "Video không có phụ đề và chưa cấu hình Speech-to-Text." });
  });

  it("a cached video needs no provider at all", async () => {
    const { service, resolver } = setup();
    await service.read(URL_VIDEO);
    await service.read(URL_VIDEO);
    expect(resolver.video).toHaveBeenCalledTimes(1);
  });
});
