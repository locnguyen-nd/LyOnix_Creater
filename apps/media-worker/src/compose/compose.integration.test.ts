import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildVideoComposeJob, composeFingerprint, type VideoComposeProgress, type VideoComposeSuccess } from "@lyonix/media-jobs";
import { NEWS_RECAP_BROADCAST_TELOP_JP_V1, RecipeRegistry, type RenderRecipe } from "@lyonix/render-recipes";
import { runProcess } from "../process.js";
import { ComposeProcessor } from "./compose-processor.js";
import { detectFfmpeg, ffmpegPath, ffprobePath, findJapaneseFont, generate, makeFixtures, makePlan, testRecipe, type FixtureFiles } from "./test-fixtures.js";

/**
 * VE2E-105 integration: composes real videos with the REAL ffmpeg/ffprobe from synthetic lavfi fixtures (nothing committed). Skipped
 * with a clear message when FFmpeg (with libx264, libass, xfade, loudnorm) is not installed.
 */
const availability = detectFfmpeg();
if (!availability.ok) console.warn(`[media-worker] SKIPPING compose integration tests: ${availability.reason}.`);

const japaneseFont = findJapaneseFont();
const FONT = japaneseFont ?? "DejaVu Sans";

/** The released recipe with this host's font substituted (CI/dev machines do not have Noto Sans CJK JP): geometry, timing and audio policy are untouched. */
const releasedWithHostFont = (): RenderRecipe => {
  const recipe = structuredClone(NEWS_RECAP_BROADCAST_TELOP_JP_V1);
  recipe.captions.fontFamily = FONT;
  recipe.fonts = [FONT];
  for (const layer of recipe.layers) if (layer.type === "text") layer.fontFamily = FONT;
  return recipe;
};

describe.skipIf(!availability.ok)("video.compose with real FFmpeg", () => {
  let root: string;
  let files: FixtureFiles;
  let processor: ComposeProcessor;
  const version = availability.ok ? availability.version : "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lyonix-compose-it-"));
    files = await makeFixtures(root);
    processor = new ComposeProcessor({
      config: { mediaRoot: root, ffmpegPath, ffprobePath, maxAttempts: 1 },
      compose: { queue: "lyonix.render.test", prefetch: 1, timeoutMs: 180_000, x264Preset: "ultrafast", x264Threads: 0, fontsDir: null },
      runner: runProcess,
      ffmpegVersion: version,
      recipes: new RecipeRegistry([testRecipe(FONT), releasedWithHostFont()]),
    });
  }, 120_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const probe = (path: string) => {
    const result = spawnSync(ffprobePath, ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" });
    return JSON.parse(result.stdout) as { streams: Array<Record<string, string>>; format: Record<string, string> };
  };

  it("renders 3 scenes (image, landscape video, short portrait video) with transitions, music, captions and a headline to 1080x1920 60 fps CFR", async () => {
    const text = japaneseFont ? ["政府は新しい経済対策を発表しました。", "物価高への対応を急ぐ方針です。", "来月から実施される見通しです。"] : undefined;
    const plan = makePlan(files, { withMusic: true, texts: text ?? [], params: { headline: japaneseFont ? "速報：経済対策" : "BREAKING NEWS" } });
    if (!text) plan.scenes.forEach((scene, index) => (scene.text = `Scene ${index + 1} caption text`));
    const job = buildVideoComposeJob({ jobKey: "compose:it-1", recipe: { id: "test-telop", version: 1 }, plan });
    const progress: VideoComposeProgress[] = [];

    const result = await processor.handle(job, (p) => progress.push(p));
    if (!result.ok) throw new Error(`compose failed: ${result.error.code}: ${result.error.message}`);
    expect(result.qc.passed).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.output.fps).toBe(60);
    expect(result.metrics.x264Preset).toBe("ultrafast");

    const out = probe(join(root, result.output.relativePath));
    const v = out.streams.find((s) => s.codec_type === "video")!;
    const a = out.streams.find((s) => s.codec_type === "audio")!;
    expect([v.width, v.height]).toEqual(["1080", "1920"].map(Number));
    expect(v.r_frame_rate).toBe("60/1");
    expect(v.avg_frame_rate).toBe("60/1");
    expect(v.codec_name).toBe("h264");
    expect(v.profile).toBe("High");
    expect(v.pix_fmt).toBe("yuv420p");
    expect(v.color_space).toBe("bt709");
    expect(v.color_range).toBe("tv");
    expect(Number(v.nb_read_frames)).toBe(plan.totalFrames); // CFR, exactly the planned number of frames
    expect(Math.abs(Number(out.format.duration) * 1000 - (plan.totalFrames * 1000) / 60)).toBeLessThanOrEqual(100);
    expect(a.codec_name).toBe("aac");
    expect(a.sample_rate).toBe("48000");
    expect(Number(a.channels)).toBe(2);

    const thumb = probe(join(root, result.thumbnail.relativePath));
    expect([thumb.streams[0]!.width, thumb.streams[0]!.height]).toEqual([1080, 1920]);
    expect(thumb.streams[0]!.codec_name).toBe("mjpeg");

    expect(progress.map((p) => p.stage)).toContain("preparing");
    expect(progress.map((p) => p.stage)).toContain("encoding");
    expect(progress.every((p) => p.jobKey === "compose:it-1" && p.percent >= 0 && p.percent <= 100)).toBe(true);
    const percents = progress.map((p) => p.percent);
    expect([...percents].sort((x, y) => x - y)).toEqual(percents);
    expect((await stat(join(root, result.output.relativePath))).size).toBe(result.output.bytes);
  }, 240_000);

  it("renders the released recipe news-recap-broadcast-telop-jp@1 and passes the full QC gate (default badge, with and without a headline)", async () => {
    const texts = japaneseFont ? ["政府は新しい経済対策を発表しました。", "物価高への対応を急ぐ方針です。", "来月から実施される見通しです。"] : ["First scene text", "Second scene text", "Third scene text"];
    const plan = makePlan(files, { texts, withMusic: true, params: { headline: japaneseFont ? "経済対策を発表" : "NEWS HEADLINE" }, padStartMs: 300, padEndMs: 800 });
    const result = await processor.handle(buildVideoComposeJob({ jobKey: "compose:it-released", recipe: { id: NEWS_RECAP_BROADCAST_TELOP_JP_V1.id, version: 1 }, plan }));
    if (!result.ok) throw new Error(`released recipe failed: ${result.error.code}: ${result.error.message}`);
    expect(result.qc.passed).toBe(true);
    expect(result.tool.recipe).toEqual({ id: "news-recap-broadcast-telop-jp", version: 1 });
    if (process.env.LYONIX_KEEP_RENDER) console.info(`released-recipe render kept at ${join(root, result.output.relativePath)}`);

    const noHeadline = await processor.handle(buildVideoComposeJob({ jobKey: "compose:it-released-2", recipe: { id: NEWS_RECAP_BROADCAST_TELOP_JP_V1.id, version: 1 }, plan: { ...plan, params: {} } }));
    expect(noHeadline.ok).toBe(true);
    if (noHeadline.ok) expect(noHeadline.output.sha256).not.toBe(result.output.sha256); // the band/badge layers really change the picture
  }, 300_000);

  it("fails fast with FONT_MISSING (a technical failure: the Router falls back) when the recipe font is not installed", async () => {
    const ghost = { ...testRecipe("Definitely Not Installed Font"), id: "ghost-font" };
    const missing = new ComposeProcessor({
      config: { mediaRoot: root, ffmpegPath, ffprobePath, maxAttempts: 1 },
      compose: { queue: "q", prefetch: 1, timeoutMs: 60_000, x264Preset: "ultrafast", x264Threads: 0, fontsDir: null },
      runner: runProcess,
      ffmpegVersion: version,
      recipes: new RecipeRegistry([ghost]),
    });
    const hasFontconfig = spawnSync("fc-list", [":", "family"], { encoding: "utf8" }).status === 0;
    const result = await missing.handle(buildVideoComposeJob({ jobKey: "compose:it-ghost", recipe: { id: "ghost-font", version: 1 }, plan: makePlan(files, { voiceSeconds: [1, 1, 1] }) }));
    if (hasFontconfig) expect(result).toMatchObject({ ok: false, error: { code: "FONT_MISSING", retryable: false } });
    else expect(result.ok).toBe(true); // without fontconfig the check is skipped (documented), the render proceeds
  }, 120_000);

  it("a slowly zooming smooth photo is not flagged as frozen, while the same photo with the animation switched off is allowed to be still", async () => {
    generate(["-f", "lavfi", "-i", "gradients=size=1920x1080:rate=1:duration=1:seed=7:n=4", "-frames:v", "1", join(root, "projects/p/smooth.jpg")]);
    const smooth = { ...files, image: "projects/p/smooth.jpg" };
    const plan = makePlan(smooth, { voiceSeconds: [5], texts: [""] });
    const moving = await processor.handle(buildVideoComposeJob({ jobKey: "compose:it-smooth", recipe: { id: "test-telop", version: 1 }, plan }));
    if (!moving.ok) throw new Error(`smooth photo with zoom failed: ${moving.error.code}: ${moving.error.message}`);
    expect(moving.qc.measured.freezeMs).toBe(0);

    const still = structuredClone(plan);
    still.params = { "dynamicStyle.imageAnimation": "none" };
    const result = await processor.handle(buildVideoComposeJob({ jobKey: "compose:it-smooth-still", recipe: { id: "test-telop", version: 1 }, plan: still }));
    if (!result.ok) throw new Error(`static photo failed: ${result.error.code}: ${result.error.message}`);
    expect(result.qc.checks.find((c) => c.code === "QC_FREEZE")).toMatchObject({ ok: true, measured: "skipped (static by design)" });
  }, 240_000);

  it("is idempotent by jobKey: a second delivery reuses the stored render without running FFmpeg again", async () => {
    const plan = makePlan(files, { voiceSeconds: [2, 2, 2] });
    const job = buildVideoComposeJob({ jobKey: "compose:it-idem", recipe: { id: "test-telop", version: 1 }, plan });
    const first = await processor.handle(job);
    expect(first.ok).toBe(true);
    const second = (await processor.handle(job)) as VideoComposeSuccess;
    expect(second.ok).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.output.sha256).toBe((first as VideoComposeSuccess).output.sha256);

    const conflicting = buildVideoComposeJob({ jobKey: "compose:it-idem", recipe: { id: "test-telop", version: 1 }, plan: makePlan(files, { voiceSeconds: [2, 2, 3] }) });
    expect(composeFingerprint(conflicting)).not.toBe(composeFingerprint(job));
    const conflict = await processor.handle(conflicting);
    expect(conflict).toMatchObject({ ok: false, error: { code: "JOB_KEY_CONFLICT" } });
  }, 240_000);

  it("fails with a clear code for missing sources, unknown recipes and unsafe paths (no output left behind)", async () => {
    const plan = makePlan(files, { voiceSeconds: [1, 1, 1] });
    const missing = structuredClone(plan);
    missing.scenes[1]!.media.relativePath = "projects/p/does-not-exist.mp4";
    expect(await processor.handle(buildVideoComposeJob({ jobKey: "compose:it-missing", recipe: { id: "test-telop", version: 1 }, plan: missing }))).toMatchObject({ ok: false, error: { code: "SOURCE_NOT_FOUND" } });

    expect(await processor.handle(buildVideoComposeJob({ jobKey: "compose:it-recipe", recipe: { id: "nope", version: 1 }, plan }))).toMatchObject({ ok: false, error: { code: "RECIPE_NOT_FOUND" } });

    const unsafe = structuredClone(plan);
    unsafe.scenes[0]!.voice.relativePath = "../etc/passwd";
    expect(await processor.handle({ ...buildVideoComposeJob({ jobKey: "compose:it-unsafe", recipe: { id: "test-telop", version: 1 }, plan: unsafe }) })).toMatchObject({ ok: false, error: { code: "INVALID_JOB" } });

    const notAudio = structuredClone(plan);
    notAudio.scenes[0]!.voice.relativePath = files.image; // a JPEG as the voice
    expect(await processor.handle(buildVideoComposeJob({ jobKey: "compose:it-noaudio", recipe: { id: "test-telop", version: 1 }, plan: notAudio }))).toMatchObject({ ok: false, error: { code: "INVALID_JOB" } });
  }, 120_000);
});
