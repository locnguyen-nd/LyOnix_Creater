import { describe, expect, it } from "vitest";
import type { PexelsAttribution, PexelsPhotoSearchResultResponse, PexelsVideoSearchResultResponse } from "@lyonix/contracts";

import { pickBestPhotoCandidate, pickBestVideoCandidate } from "./media-selection.js";

const attribution: PexelsAttribution = { photographerName: "Jane Doe", photographerUrl: "https://pexels.com/@jane", pexelsPageUrl: "https://pexels.com/photo/1" };

const video = (overrides: Partial<PexelsVideoSearchResultResponse>): PexelsVideoSearchResultResponse => ({
  externalId: "v1",
  width: 1080,
  height: 1920,
  durationSeconds: 10,
  attribution,
  thumbnailUrl: "https://x/thumb.jpg",
  fileOptions: [],
  ...overrides,
});

const photo = (overrides: Partial<PexelsPhotoSearchResultResponse>): PexelsPhotoSearchResultResponse => ({
  externalId: "p1",
  width: 1080,
  height: 1920,
  attribution,
  thumbnailUrl: "https://x/thumb.jpg",
  previewUrl: "https://x/preview.jpg",
  ...overrides,
});

describe("pickBestVideoCandidate", () => {
  it("skips a candidate already used elsewhere in the same video", () => {
    const candidates = [video({ externalId: "used" }), video({ externalId: "fresh" })];
    const pick = pickBestVideoCandidate(candidates, new Set(["used"]), 5);
    expect(pick?.externalId).toBe("fresh");
  });

  it("returns null once every candidate has already been used", () => {
    const candidates = [video({ externalId: "a" }), video({ externalId: "b" })];
    expect(pickBestVideoCandidate(candidates, new Set(["a", "b"]), 5)).toBeNull();
  });

  it("prefers a clip long enough to cover the scene's duration over a too-short one", () => {
    const short = video({ externalId: "short", durationSeconds: 2 });
    const longEnough = video({ externalId: "long-enough", durationSeconds: 8 });
    const pick = pickBestVideoCandidate([short, longEnough], new Set(), 6);
    expect(pick?.externalId).toBe("long-enough");
  });

  it("prefers portrait framing over landscape when duration is equally sufficient", () => {
    const landscape = video({ externalId: "landscape", width: 1920, height: 1080, durationSeconds: 10 });
    const portrait = video({ externalId: "portrait", width: 1080, height: 1920, durationSeconds: 10 });
    const pick = pickBestVideoCandidate([landscape, portrait], new Set(), 5);
    expect(pick?.externalId).toBe("portrait");
  });

  it("among several long-enough candidates prefers the closest duration instead of the longest", () => {
    const tooLong = video({ externalId: "too-long", durationSeconds: 60 });
    const closeFit = video({ externalId: "close-fit", durationSeconds: 6 });
    const pick = pickBestVideoCandidate([tooLong, closeFit], new Set(), 5);
    expect(pick?.externalId).toBe("close-fit");
  });
});

describe("pickBestPhotoCandidate", () => {
  it("skips already-used candidates and prefers portrait framing", () => {
    const used = photo({ externalId: "used", width: 1080, height: 1920 });
    const landscape = photo({ externalId: "landscape", width: 1920, height: 1080 });
    const portrait = photo({ externalId: "portrait", width: 1080, height: 1920 });
    const pick = pickBestPhotoCandidate([used, landscape, portrait], new Set(["used"]));
    expect(pick?.externalId).toBe("portrait");
  });

  it("returns null once every candidate has already been used", () => {
    expect(pickBestPhotoCandidate([photo({ externalId: "a" })], new Set(["a"]))).toBeNull();
  });
});
