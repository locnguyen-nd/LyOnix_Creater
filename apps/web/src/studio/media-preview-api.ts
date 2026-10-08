import type { MediaAssetKind, MediaDeliveryIssueResponse } from "@lyonix/contracts";
import { api, csrfHeaders } from "../api";
import { deliveryUrlForBrowser } from "./media-url";

export const isInlinePreviewableMediaKind = (kind: MediaAssetKind) => kind === "image" || kind === "video";

export async function createMediaPreviewUrl(assetId: string): Promise<string> {
  const delivery = await api<MediaDeliveryIssueResponse>(`/media-assets/${assetId}/delivery-tokens`, {
    method: "POST",
    headers: await csrfHeaders(),
  });
  return deliveryUrlForBrowser(delivery);
}
