import { DEFAULT_MEDIA_FETCH_QUEUE } from "@lyonix/media-jobs";
import { MediaWorkerConfigError } from "../config.js";

export type SocialFetchConfig = {
  /** MEDIA_WORKER_FETCH (default on): consume `lyonix.media.fetch`. The CLIs are still optional: a missing one answers FETCH_TOOL_MISSING. */
  enabled: boolean;
  queue: string;
  /** Parallel downloads/searches; network-bound, so NOT capped by the CPU count (default 4). */
  prefetch: number;
  ytDlpPath: string;
  galleryDlPath: string;
  /** MEDIA_FETCH_PROXY: used only for jobs with `useProxy: true`; never sent back in a result or a log line. */
  proxyUrl: string | null;
};

/**
 * VE2E-144 env contract (all optional): MEDIA_WORKER_FETCH (0/1, default 1), MEDIA_WORKER_QUEUE_FETCH (default `lyonix.media.fetch`),
 * MEDIA_WORKER_PREFETCH_FETCH (1..16, default 4), YTDLP_PATH (default `yt-dlp`), GALLERY_DL_PATH (default `gallery-dl`),
 * MEDIA_FETCH_PROXY (http(s)/socks5 URL).
 */
export const loadSocialFetchConfig = (env: NodeJS.ProcessEnv): SocialFetchConfig => {
  const flag = env.MEDIA_WORKER_FETCH?.trim().toLowerCase();
  if (flag && !["0", "1", "true", "false", "on", "off", "yes", "no"].includes(flag)) throw new MediaWorkerConfigError(`MEDIA_WORKER_FETCH must be 0/1/true/false (got "${flag}")`);
  const rawPrefetch = env.MEDIA_WORKER_PREFETCH_FETCH?.trim();
  const prefetch = rawPrefetch ? Number(rawPrefetch) : 4;
  if (!Number.isInteger(prefetch) || prefetch < 1 || prefetch > 16) throw new MediaWorkerConfigError(`MEDIA_WORKER_PREFETCH_FETCH must be an integer in [1, 16] (got "${rawPrefetch}")`);
  const proxy = env.MEDIA_FETCH_PROXY?.trim() || null;
  if (proxy && !/^(https?|socks5h?):\/\/[^\s]+$/i.test(proxy)) throw new MediaWorkerConfigError("MEDIA_FETCH_PROXY must be an http(s):// or socks5:// URL");
  return {
    enabled: !flag || ["1", "true", "on", "yes"].includes(flag),
    queue: env.MEDIA_WORKER_QUEUE_FETCH?.trim() || DEFAULT_MEDIA_FETCH_QUEUE,
    prefetch,
    ytDlpPath: env.YTDLP_PATH?.trim() || "yt-dlp",
    galleryDlPath: env.GALLERY_DL_PATH?.trim() || "gallery-dl",
    proxyUrl: proxy,
  };
};
