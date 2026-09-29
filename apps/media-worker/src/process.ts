import { spawn } from "node:child_process";

export type ProcessResult = { exitCode: number | null; stdout: string; stderrTail: string };

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

export type ProcessRunner = (binary: string, args: readonly string[], options: { timeoutMs: number; maxStdoutBytes?: number }) => Promise<ProcessResult>;

const STDERR_TAIL_BYTES = 4096;

/**
 * Spawns a binary without a shell (args are never shell-interpolated), with a hard
 * timeout (SIGKILL) and bounded stdout/stderr buffering.
 */
export const runProcess: ProcessRunner = (binary, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    const maxStdout = options.maxStdoutBytes ?? 8 * 1024 * 1024;
    const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
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
      rejectPromise(error.code === "ENOENT" ? new BinaryNotFoundError(binary) : error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new ProcessTimeoutError(binary, options.timeoutMs));
        return;
      }
      resolvePromise({ exitCode, stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderrTail: stderr.trim() });
    });
  });

/** First line of `<binary> -version`, e.g. "ffmpeg version 7.1 ...". Throws BinaryNotFoundError if missing. */
export const readToolVersion = async (runner: ProcessRunner, binary: string): Promise<string> => {
  const result = await runner(binary, ["-hide_banner", "-version"], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(`${binary} -version exited with ${result.exitCode}`);
  return result.stdout.split(/\r?\n/)[0]?.trim() || "unknown";
};
