import { describe, expect, it } from "vitest";
import { isJobDone, routeForJob, type ApiJob } from "./jobs-api";

// VE2E-18: job list/detail must navigate to the page matching the job's real current step
// (CR-JOBS-PIPELINE-STATUS-2026-09-26 AC #1/#3), and "done" must mean an actual rendered
// video, never just an approved script.
const baseJob: ApiJob = {
  id: "job-1",
  code: "JOB-1001",
  mode: "topic",
  topic: "Lionel Messi",
  locale: "vi",
  status: "handoff_workspace_ready",
  currentStep: "done",
  channelId: "channel-1",
  promptSpec: "",
  contentProviderAccountId: "account-1",
  model: "gpt-5",
  createdByUserId: "user-1",
  updatedAt: new Date().toISOString(),
  script: { title: "Messi", hook: "h", body: "b", cta: "c", caption: "#messi", scenes: [], version: 1, approvedVersion: 1 },
};

describe("routeForJob", () => {
  it("falls back to the legacy script route when pipelineStep is missing (older cached response)", () => {
    expect(routeForJob(baseJob)).toBe("/jobs/job-1/script");
  });

  it("routes 'media'/'voice' to the matching Studio tab", () => {
    expect(routeForJob({ ...baseJob, pipelineStep: "media" })).toBe("/jobs/job-1/studio?tab=media");
    expect(routeForJob({ ...baseJob, pipelineStep: "voice" })).toBe("/jobs/job-1/studio?tab=voice");
  });

  it("routes 'timeline' to plain Studio (no tab override)", () => {
    expect(routeForJob({ ...baseJob, pipelineStep: "timeline" })).toBe("/jobs/job-1/studio");
  });

  it("routes 'render'/'done' to Studio with the render-result deep link when a render id exists", () => {
    const render = { id: "render-1", status: "rendering", resultUrl: null, renderDurationMs: null, costAmount: null, costCurrency: null };
    expect(routeForJob({ ...baseJob, pipelineStep: "render", render })).toBe("/jobs/job-1/studio?renderJobId=render-1");
    expect(routeForJob({ ...baseJob, pipelineStep: "done", render: { ...render, status: "completed", resultUrl: "https://cdn.creatomate.com/x.mp4" } })).toBe(
      "/jobs/job-1/studio?renderJobId=render-1",
    );
  });

  it("falls back to plain Studio for 'render'/'done' if no render id is present (defensive)", () => {
    expect(routeForJob({ ...baseJob, pipelineStep: "render", render: null })).toBe("/jobs/job-1/studio");
  });

  it("keeps legacy script/produce/review steps on the script page", () => {
    expect(routeForJob({ ...baseJob, pipelineStep: "script" })).toBe("/jobs/job-1/script");
    expect(routeForJob({ ...baseJob, pipelineStep: "produce" })).toBe("/jobs/job-1/script");
    expect(routeForJob({ ...baseJob, pipelineStep: "review" })).toBe("/jobs/job-1/script");
  });
});

describe("isJobDone", () => {
  it("is true only for pipelineStep 'done'", () => {
    expect(isJobDone({ ...baseJob, pipelineStep: "done" })).toBe(true);
    expect(isJobDone({ ...baseJob, pipelineStep: "render" })).toBe(false);
    expect(isJobDone(baseJob)).toBe(false);
  });

  it("does not treat the legacy handoff_workspace_ready status as done", () => {
    expect(isJobDone({ ...baseJob, status: "handoff_workspace_ready" })).toBe(false);
  });
});
