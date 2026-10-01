import { describe, expect, it } from "vitest";
import type { WorkflowStepEventResponse } from "@lyonix/contracts";
import { currentStage, stageOfStep, summarizeStages } from "./video-production-stages";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
const ev = (stepKey: string, status: WorkflowStepEventResponse["status"], start: number | null, end: number | null, attempt = 1): WorkflowStepEventResponse => ({
  stepKey, status, attempt, error: null, startedAt: start === null ? null : at(start), endedAt: end === null ? null : at(end),
});
const now = Date.parse(at(20));

describe("stageOfStep", () => {
  it("maps the Auto DAG step keys to the five stages", () => {
    expect(stageOfStep("generate_script")).toBe("script");
    expect(stageOfStep("generate_audio_sc_3")).toBe("voice");
    expect(stageOfStep("duration_budget")).toBeNull();
    expect(stageOfStep("media_plan_diagnostics")).toBeNull();
    expect(stageOfStep("extract_keywords")).toBe("keywords");
    expect(stageOfStep("import_media_seg-2")).toBe("media");
    expect(stageOfStep("submit_render")).toBe("render");
    expect(stageOfStep("something_new")).toBeNull();
  });
});

describe("summarizeStages", () => {
  const events = [
    ev("generate_script", "succeeded", 0, 1), ev("persist_script_version", "succeeded", 1, 1),
    ev("generate_audio_s01", "succeeded", 1, 2), ev("generate_audio_s02", "succeeded", 1, 3),
    ev("extract_keywords", "succeeded", 3, 4),
    ev("import_media_seg-1", "succeeded", 4, 9), ev("import_media_seg-2", "running", 4, null),
  ];

  it("marks finished stages done, the active one running, the rest pending", () => {
    const stages = summarizeStages(events, { status: "media_preparing", updatedAt: at(10) }, now);
    expect(stages.map((s) => s.status)).toEqual(["done", "done", "done", "running", "pending"]);
    const media = stages[3]!;
    expect(media).toMatchObject({ stepsDone: 1, stepsTotal: 2, endMs: now });
    expect(currentStage(stages).key).toBe("media");
  });

  it("treats the provider render phase as the running render stage and completes it on success", () => {
    const all = [...events.slice(0, 5), ev("import_media_seg-1", "succeeded", 4, 9), ev("persist_timeline_version", "succeeded", 9, 9), ev("submit_render", "succeeded", 9, 9)];
    expect(summarizeStages(all, { status: "rendering", updatedAt: at(12) }, now)[4]).toMatchObject({ status: "running", endMs: now });
    expect(summarizeStages(all, { status: "completed", updatedAt: at(15) }, now)[4]).toMatchObject({ status: "done", endMs: Date.parse(at(15)) });
  });

  it("flags the stage of a failed run and ignores earlier failed attempts once retried", () => {
    const failed = summarizeStages([ev("generate_script", "failed", 0, 1)], { status: "failed", updatedAt: at(2) }, now);
    expect(failed[0]!.status).toBe("failed");
    const retried = summarizeStages([ev("generate_script", "failed", 0, 1, 1), ev("generate_script", "succeeded", 5, 6, 2)], { status: "scripting", updatedAt: at(6) }, now);
    expect(retried[0]!.status).toBe("done");
  });
});
