import type { VideoComposeProgress } from "@lyonix/media-jobs";

/**
 * Parses FFmpeg's `-progress pipe:1` key=value stream. A block ends with `progress=continue|end`; `frame` is the number of
 * frames encoded so far and `speed` the realtime multiple (e.g. `1.23x`).
 */
export class FfmpegProgressParser {
  private frame = 0;
  private speed: number | null = null;

  /** Feed one line; returns a snapshot at the end of each progress block, otherwise null. */
  push(line: string): { frame: number; speedX: number | null; ended: boolean } | null {
    const eq = line.indexOf("=");
    if (eq < 0) return null;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "frame") {
      const frame = Number(value);
      if (Number.isFinite(frame)) this.frame = frame;
    } else if (key === "speed") {
      const speed = Number.parseFloat(value);
      this.speed = Number.isFinite(speed) ? speed : null;
    } else if (key === "progress") {
      return { frame: this.frame, speedX: this.speed, ended: value === "end" };
    }
    return null;
  }
}

export type ProgressStage = VideoComposeProgress["stage"];

/** Maps stage + encoded frames to a single 0..100 value (preparing 0-4, encoding 5-94, qc 95-98, finalizing 99-100). */
export const progressPercent = (stage: ProgressStage, frame: number | null, totalFrames: number | null): number => {
  if (stage === "preparing") return 2;
  if (stage === "encoding") return totalFrames && frame !== null ? Math.min(94, 5 + Math.floor((89 * Math.max(0, frame)) / totalFrames)) : 5;
  if (stage === "qc") return 96;
  return 99;
};
