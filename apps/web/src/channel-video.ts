import type { ChannelVideoResponse, VideoCostResponse } from "@lyonix/contracts";

/** USD for a video: cents are too coarse for a part that costs a fraction of a cent, so under $0.10 keeps four decimals. */
export const formatUsd = (value: number): string => (value >= 0.1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`);

export type CostPartKey = "render" | "content" | "tts" | "media";

/** The parts that were actually recorded (a null part is unknown, not zero), in the order they are shown. */
export const costPartsOf = (cost: VideoCostResponse): Array<{ key: CostPartKey; usd: number }> =>
  ([
    ["render", cost.renderUsd],
    ["content", cost.contentUsd],
    ["tts", cost.ttsUsd],
    ["media", cost.mediaUsd],
  ] as const).flatMap(([key, usd]) => (usd === null ? [] : [{ key, usd }]));

/** Where a library card opens: an Auto run has its own page, a Studio job opens its Studio at the finished render. */
export const channelVideoPath = (video: Pick<ChannelVideoResponse, "mode" | "jobId" | "renderJobId">): string =>
  video.mode === "auto" ? `/video-productions/${video.jobId}` : `/jobs/${video.jobId}/studio?renderJobId=${video.renderJobId}`;
