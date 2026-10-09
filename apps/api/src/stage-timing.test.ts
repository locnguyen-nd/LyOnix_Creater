import { describe, expect, it } from "vitest";
import { sanitizeDetail, stageKind, StageRecorder, summarizeTimings, timingLine } from "./stage-timing.js";
import { buildTimingReport, formatTimingReport } from "./timing-report.js";

const clock = (start = Date.parse("2026-10-09T01:00:00.000Z")) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

describe("stage timing", () => {
  it("records stage, start/end, duration, attempt, provider and cache as one [timing] line", async () => {
    const lines: string[] = [];
    const time = clock();
    const recorder = new StageRecorder("run", "run-1", (line) => lines.push(line), time.now);
    const value = await recorder.time("generate_audio_S1", { attempt: 2, provider: "elevenlabs" }, async () => { time.advance(1830); return { ok: true, data: { sourcing: "imported" } }; }, () => ({ cache: "miss" }));
    expect(value).toEqual({ ok: true, data: { sourcing: "imported" } });
    expect(recorder.events[0]).toMatchObject({ stage: "generate_audio_S1", durationMs: 1830, attempt: 2, provider: "elevenlabs", cache: "miss", ok: true, startedAt: "2026-10-09T01:00:00.000Z", endedAt: "2026-10-09T01:00:01.830Z" });
    expect(lines[0]!.startsWith("[timing] ")).toBe(true);
    expect(JSON.parse(lines[0]!.slice(9))).toMatchObject({ scope: "run", id: "run-1", stage: "generate_audio_S1", durationMs: 1830 });
  });

  it("records a failure with its code and rethrows; a cache hit is 0 ms", async () => {
    const time = clock();
    const recorder = new StageRecorder("render", "job-1", () => undefined, time.now);
    await expect(recorder.time("render_compose", {}, async () => { time.advance(50); throw Object.assign(new Error("boom"), { code: "FFMPEG_TIMEOUT" }); })).rejects.toThrow("boom");
    recorder.hit("generate_audio_S2", { provider: "elevenlabs" });
    expect(recorder.events).toMatchObject([{ stage: "render_compose", ok: false, code: "FFMPEG_TIMEOUT", durationMs: 50 }, { stage: "generate_audio_S2", cache: "hit", durationMs: 0 }]);
  });

  it("never logs URLs, paths or tokens in detail", () => {
    expect(sanitizeDetail({ tier: "pexels", url: "https://x.example/api/v1/media-delivery/tok", path: "working/renders/a.mp4", token: "sk_live:abc", ms: 12.3456, ok: true, nothing: null })).toEqual({ tier: "pexels", ms: 12.346, ok: true, nothing: null });
    const line = timingLine("run", "r", { stage: "s", startedAt: "a", endedAt: "b", durationMs: 1, attempt: 1, provider: null, cache: "n/a", ok: true, detail: { key: "Bearer abc/def" } });
    expect(line).not.toContain("Bearer");
  });

  it("classifies network / local / queue / wrapper stages", () => {
    expect(stageKind("generate_script")).toBe("network");
    expect(stageKind("import_media_seg-3")).toBe("network");
    expect(stageKind("render_prepare_clips")).toBe("local");
    expect(stageKind("ffmpeg_videoEncode")).toBe("local");
    expect(stageKind("render_queue_wait")).toBe("queue");
    expect(stageKind("media_sourcing")).toBe("wrapper");
  });

  it("summary: wall clock, slowest leaf stages (wrappers excluded), cache hits, failures, retries", () => {
    const at = (s: number) => new Date(Date.parse("2026-10-09T01:00:00Z") + s * 1000).toISOString();
    const summary = summarizeTimings([
      { stage: "media_sourcing", startedAt: at(0), endedAt: at(100), durationMs: 100_000, attempt: 1, provider: null, cache: "n/a", ok: true },
      { stage: "import_media_seg-1", startedAt: at(0), endedAt: at(90), durationMs: 90_000, attempt: 2, provider: "pexels", cache: "miss", ok: true },
      { stage: "generate_audio_S1", startedAt: at(0), endedAt: at(0), durationMs: 0, attempt: 2, provider: "elevenlabs", cache: "hit", ok: true },
      { stage: "render_compose", startedAt: at(100), endedAt: at(160), durationMs: 60_000, attempt: 2, provider: "lyonix", cache: "miss", ok: false, code: "QC_AUDIO" },
    ]);
    expect(summary.wallMs).toBe(160_000);
    expect(summary.slowest.map((row) => row.stage)).toEqual(["import_media_seg-1", "generate_audio_S1"]);
    expect(summary.cacheHits).toEqual(["generate_audio_S1"]);
    expect(summary.failed).toEqual([{ stage: "render_compose", code: "QC_AUDIO", attempt: 2 }]);
    expect(summary.maxAttempt).toBe(2);
  });
});

describe("timing report", () => {
  const created = new Date("2026-10-09T01:00:00Z");
  const t = (s: number) => new Date(created.getTime() + s * 1000);

  it("uses the persisted stage_timings + render_timings when present", () => {
    const event = (stage: string, from: number, to: number, extra = {}) => ({ stage, startedAt: t(from).toISOString(), endedAt: t(to).toISOString(), durationMs: (to - from) * 1000, attempt: 1, provider: null, cache: "n/a", ok: true, ...extra });
    const report = buildTimingReport({
      run: { id: "run-1", status: "rendering", attempts: 1, createdAt: created },
      steps: [
        { stepKey: "stage_timings", status: "succeeded", attempt: 1, startedAt: t(80), endedAt: t(80), outputRef: { events: [event("generate_script", 2, 32, { provider: "gemini" }), event("import_media_seg-1", 32, 70, { provider: "pexels" })] }, error: null },
        { stepKey: "render_timings", status: "succeeded", attempt: 1, startedAt: t(81), endedAt: t(140), outputRef: { renderJobId: "job-1", events: [event("render_queue_wait", 80, 81), event("render_prepare_clips", 81, 95, { cache: "hit" }), event("ffmpeg_videoEncode", 95, 140)] }, error: null },
      ],
      operations: [],
      renders: [{ id: "job-1", engine: "lyonix", status: "completed", createdAt: t(80), submittedAt: t(95), completedAt: t(141), renderDurationMs: 45_000, clipsTotal: 4, errorCode: null }],
    });
    expect(report.source).toBe("stage_timings");
    expect(report.totalMs).toBe(141_000);
    expect(report.queuedBeforeStartMs).toBe(2000);
    expect(report.slowest.map((row) => row.stage)).toEqual(["ffmpeg_videoEncode", "import_media_seg-1", "generate_script"]);
    expect(report.cacheHits).toEqual(["render_prepare_clips"]);
    const text = formatTimingReport(report);
    expect(text).toContain("render/ffmpeg_videoEncode");
    expect(text).toContain("Total 141.0s");
  });

  it("falls back to StepRun start/end for runs recorded before stage timing, skipping bookkeeping rows", () => {
    const report = buildTimingReport({
      run: { id: "run-old", status: "failed", attempts: 1, createdAt: created },
      steps: [
        { stepKey: "generate_script", status: "succeeded", attempt: 1, startedAt: t(1), endedAt: t(31), outputRef: null, error: null },
        { stepKey: "duration_budget", status: "succeeded", attempt: 1, startedAt: t(31), endedAt: t(900), outputRef: null, error: null },
        { stepKey: "import_media_seg-1", status: "failed", attempt: 1, startedAt: t(31), endedAt: t(90), outputRef: null, error: { code: "PROVIDER_QUOTA_EXHAUSTED" } },
      ],
      operations: [{ stepKey: "generate_script", provider: "gemini", status: "succeeded", errorCode: null }],
      renders: [],
    });
    expect(report.source).toBe("step_runs");
    expect(report.events.map((row) => row.stage)).toEqual(["generate_script", "import_media_seg-1"]);
    expect(report.events[0]!.provider).toBe("gemini");
    expect(report.failures).toEqual([{ stage: "import_media_seg-1", code: "PROVIDER_QUOTA_EXHAUSTED", attempt: 1 }]);
  });
});
