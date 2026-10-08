import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), csrfHeaders: vi.fn(), API_ORIGIN: "http://localhost:3000" }));
vi.mock("../api", () => mocks);

import { createMediaPreviewUrl, isInlinePreviewableMediaKind } from "./media-preview-api";

describe("media preview delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues a scoped delivery URL only when preview is requested, loaded from the API origin", async () => {
    const headers = { "x-csrf-token": "csrf" };
    mocks.csrfHeaders.mockResolvedValue(headers);
    mocks.api.mockResolvedValue({ url: "https://dead-tunnel.example/api/v1/media-delivery/short-lived", path: "/api/v1/media-delivery/short-lived" });

    await expect(createMediaPreviewUrl("asset-1")).resolves.toBe("http://localhost:3000/api/v1/media-delivery/short-lived");
    expect(mocks.api).toHaveBeenCalledWith("/media-assets/asset-1/delivery-tokens", { method: "POST", headers });
  });

  it("allows inline preview only for images and videos", () => {
    expect(isInlinePreviewableMediaKind("image")).toBe(true);
    expect(isInlinePreviewableMediaKind("video")).toBe(true);
    expect(isInlinePreviewableMediaKind("audio")).toBe(false);
    expect(isInlinePreviewableMediaKind("document")).toBe(false);
  });
});
