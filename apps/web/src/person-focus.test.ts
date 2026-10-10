import { describe, expect, it } from "vitest";
import { personFocusWarnings } from "./person-focus";

describe("VE2E-151 person focus warnings", () => {
  it("keeps only the person-focus codes of the quality gate", () => {
    const gate = {
      checks: [],
      fixes: [],
      warnings: [
        { code: "subtitle_over_lines", sceneId: "s1", detail: "x" },
        { code: "script_off_target", detail: "Kịch bản chưa bám sát Lee Felix" },
        { code: "person_media_low_confidence", detail: "Không đủ media chắc chắn là Lee Felix" },
      ],
      degraded: { count: 0, sceneIds: [], tiers: {} },
      failure: null,
    };
    expect(personFocusWarnings(gate).map((warning) => warning.code)).toEqual(["script_off_target", "person_media_low_confidence"]);
    expect(personFocusWarnings(null)).toEqual([]);
  });
});

describe("VE2E-152 overlay fallback warning", () => {
  it("keeps only the media_overlay_fallback code", async () => {
    const { overlayFallbackWarnings } = await import("./person-focus");
    const gate = { checks: [], fixes: [], warnings: [{ code: "media_overlay_fallback", detail: "Không đủ footage sạch, đang dùng media có overlay nhẹ. (1 cảnh: s2)" }, { code: "script_off_target", detail: "x" }], degraded: { count: 0, sceneIds: [], tiers: {} }, failure: null };
    expect(overlayFallbackWarnings(gate).map((warning) => warning.code)).toEqual(["media_overlay_fallback"]);
    expect(overlayFallbackWarnings(undefined)).toEqual([]);
  });
});

describe("strict person coverage lines", () => {
  it("'Đúng người: 8/12 cảnh (67%)' and 'Cảnh bối cảnh: 4/12' come from the gate's coverage; none without a person target", async () => {
    const { personCoverageLines } = await import("./person-focus");
    const coverage = { totalScenes: 12, exactPersonSceneCount: 7, personSceneCount: 8, contextSceneCount: 3, genericSceneCount: 1, personCoverageRatio: 0.667, consecutiveGenericMax: 1, minCoverage: 0.65, ok: true, reasons: [], scenes: [] };
    const gate = { checks: [], fixes: [], warnings: [], degraded: { count: 0, sceneIds: [], tiers: {} }, failure: null, personMedia: { onTargetShare: 0.67, verifiedShare: 0.5, genericShare: 0.33, lowConfidence: false, strict: true, coverage } };
    expect(personCoverageLines(gate)).toEqual({ person: { count: 8, total: 12, percent: 67 }, context: { count: 4, total: 12 }, generic: 1, strict: true, ok: true });
    const { coverage: _dropped, ...withoutCoverage } = gate.personMedia;
    expect(personCoverageLines({ ...gate, personMedia: withoutCoverage })).toBeNull();
    expect(personCoverageLines(null)).toBeNull();
  });
});

describe("template slots + provider failures on the job page", () => {
  it("lists the still-missing required slots (scene + kind) and the fallbacks", async () => {
    const { templateSlotLines } = await import("./person-focus");
    const issue = { sceneId: "scene_7", sceneNumber: 7, slotKey: "Image-7.source", expectedKind: "image" as const, actualKind: "video" as const };
    const slots = { applies: true, sceneCount: 10, sceneSlots: 10, maxScenes: 10, mode: "fixed" as const, issues: [issue], fixes: [{ sceneId: "scene_10", slotKey: "Image-10.source", kind: "image" as const, fallback: "reuse_window", mediaAssetVersionId: "x" }], unresolved: [issue] };
    expect(templateSlotLines(slots)).toEqual({ missing: ["Image-7.source (cảnh 7: cần ảnh, đang là video)"], fixed: ["Image-10.source -> reuse_window"] });
    expect(templateSlotLines({ ...slots, applies: false })).toBeNull();
  });

  it("counts the provider failures per segment", async () => {
    const { providerFailureLines } = await import("./person-focus");
    const segments = [
      { segmentId: "seg-1", fallbackReason: "apify_error:PROVIDER_QUOTA_EXHAUSTED" },
      { segmentId: "seg-2", fallbackReason: "apify_quota_exhausted_all_accounts" },
      { segmentId: "seg-3", fallbackReason: null },
    ] as never;
    expect(providerFailureLines(segments)).toEqual(["Apify: PROVIDER_QUOTA_EXHAUSTED - 1 đoạn", "Apify: hết quota (mọi account) - 1 đoạn"]);
  });
});
