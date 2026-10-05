import type { MediaAssetKind } from "@lyonix/contracts";
import { api, csrfHeaders } from "../api";

export const isInlinePreviewableMediaKind = (kind: MediaAssetKind) => kind === "image" || kind === "video";

export async function createMediaPreviewUrl(assetId: string): Promise<string> {
  const delivery = await api<{ url: string }>(`/media-assets/${assetId}/delivery-tokens`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
  return delivery.url;
}
