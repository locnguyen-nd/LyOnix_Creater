import type { PexelsOutcome } from "./pexels.service.js";

/**
 * Master switch for stock sourcing from Pexels: env `PEXELS_SOURCING_ENABLED` (default on; `0|false|off|no` turns it off).
 * Off = Studio Pexels search/import and the Auto/Studio media-plan fallback are all refused, so every
 * image/video comes from Apify (TikTok / X / Pinterest) or the user's own uploads.
 */
export const pexelsSourcingEnabled = (): boolean => !/^(0|false|off|no)$/i.test((process.env.PEXELS_SOURCING_ENABLED ?? "").trim());

export const PEXELS_DISABLED_MESSAGE = "Nguồn Pexels đã bị tắt (PEXELS_SOURCING_ENABLED=off); dùng Apify (TikTok/X/Pinterest) hoặc tải lên.";

export const pexelsDisabledOutcome = (): Extract<PexelsOutcome<never>, { ok: false }> => ({
  ok: false,
  code: "PROVIDER_CAPABILITY_UNAVAILABLE",
  message: PEXELS_DISABLED_MESSAGE,
  status: 403,
});
