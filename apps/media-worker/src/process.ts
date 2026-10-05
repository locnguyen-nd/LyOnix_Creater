import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const CLOCK_TICKS_PER_SECOND = 100; // USER_HZ on every mainstream Linux; /proc/<pid>/stat is expressed in it

/** utime+stime (seconds) of a live process from /proc/<pid>/stat, or null when unavailable (non-Linux, process gone). */
const readCpuSeconds = (pid: number | undefined): number | null => {
  if (!pid || process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) ": field 3 is state
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    return Number.isFinite(utime) && Number.isFinite(stime) ? (utime + stime) / CLOCK_TICKS_PER_SECOND : null;
  } catch {
    return null;
  }
};

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderrTail: string;
  /** user+system CPU seconds of the process, sampled from /proc on Linux (`sampleCpu`); null elsewhere or when not requested. */
  cpuSeconds?: number | null;
};

export class ProcessTimeoutError extends Error {
  constructor(readonly binary: string, readonly timeoutMs: number) {
    super(`${binary} exceeded ${timeoutMs}ms and was killed`);
    this.name = "ProcessTimeoutError";
  }
}

export class BinaryNotFoundError extends Error {
  constructor(readonly binary: string) {
    super(`${binary} not found`);
    this.name = "BinaryNotFoundError";
  }
}

export type ProcessRunnerOptions = {
  timeoutMs: number;
  maxStdoutBytes?: number;
  /** Working directory of the child (lets a filtergraph reference sibling files by simple relative names). */
  cwd?: string;
  /** Called for every complete stdout line as it arrives (e.g. ffmpeg `-progress pipe:1`). Lines are not retained beyond `maxStdoutBytes`. */
  onStdoutLine?: (line: string) => void;
  /** Sample the child's CPU time (Linux `/proc/<pid>/stat`, sampled every 200 ms) into `ProcessResult.cpuSeconds`. */
  sampleCpu?: boolean;
};

export type ProcessRunner = (binary: string, args: readonly string[], options: ProcessRunnerOptions) => Promise<ProcessResult>;

const STDERR_TAIL_BYTES = 4096;

/**
 * Spawns a binary without a shell (args are never shell-interpolated), with a hard
 * timeout (SIGKILL) and bounded stdout/stderr buffering.
 */
export const runProcess: ProcessRunner = (binary, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    const maxStdout = options.maxStdoutBytes ?? 8 * 1024 * 1024;
    const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, ...(options.cwd ? { cwd: options.cwd } : {}) });
    let lineBuffer = "";
    let cpuSeconds: number | null = null;
    const cpuTimer = options.sampleCpu
      ? setInterval(() => {
          cpuSeconds = readCpuSeconds(child.pid) ?? cpuSeconds;
        }, 200)
      : null;
    cpuTimer?.unref();
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdoutLine) {
        lineBuffer += chunk.toString("utf8");
        let newline = lineBuffer.indexOf("\n");
        while (newline >= 0) {
          options.onStdoutLine(lineBuffer.slice(0, newline).replace(/\r$/, ""));
          lineBuffer = lineBuffer.slice(newline + 1);
          newline = lineBuffer.indexOf("\n");
        }
      }
      if (stdoutBytes >= maxStdout) return;
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cpuTimer) clearInterval(cpuTimer);
      rejectPromise(error.code === "ENOENT" ? new BinaryNotFoundError(binary) : error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cpuTimer) clearInterval(cpuTimer);
      if (timedOut) {
        rejectPromise(new ProcessTimeoutError(binary, options.timeoutMs));
        return;
      }
      resolvePromise({ exitCode, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderrTail: stderr.trim(), ...(options.sampleCpu ? { cpuSeconds } : {}) });
    });
  });

/** First line of `<binary> -version`, e.g. "ffmpeg version 7.1 ...". Throws BinaryNotFoundError if missing. */
export const readToolVersion = async (runner: ProcessRunner, binary: string): Promise<string> => {
  const result = await runner(binary, ["-hide_banner", "-version"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(`${binary} -version exited with ${result.exitCode}`);
  return result.stdout.split(/\r?\n/)[0]?.trim() || "unknown";
};
