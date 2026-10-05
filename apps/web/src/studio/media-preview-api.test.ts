import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), csrfHeaders: vi.fn() }));
vi.mock("../api", () => mocks);

import { createMediaPreviewUrl, isInlinePreviewableMediaKind } from "./media-preview-api";

describe("media preview delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues a scoped delivery URL only when preview is requested", async () => {
    const headers = { "x-csrf-token": "csrf" };
    mocks.csrfHeaders.mockResolvedValue(headers);
    mocks.api.mockResolvedValue({ url: "https://api.example/api/v1/media-delivery/short-lived" });

    await expect(createMediaPreviewUrl("asset-1")).resolves.toBe("https://api.example/api/v1/media-delivery/short-lived");
    expect(mocks.api).toHaveBeenCalledWith("/media-assets/asset-1/delivery-tokens", { method: "POST", headers });
  });

  it("allows inline preview only for images and videos", () => {
    expect(isInlinePreviewableMediaKind("image")).toBe(true);
    expect(isInlinePreviewableMediaKind("video")).toBe(true);
    expect(isInlinePreviewableMediaKind("audio")).toBe(false);
    expect(isInlinePreviewableMediaKind("document")).toBe(false);
  });
});
