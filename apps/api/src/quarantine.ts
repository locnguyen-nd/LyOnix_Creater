import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSafeRelativePath } from "@lyonix/domain";
import { mediaRoot } from "./handoff-workspace.js";

/**
 * Minimal local quarantine primitive reused by any future upload/import flow
 * (V03-01 chunked upload, VE2E-04 Pexels import). A file is always written to
 * `_quarantine/<uuid>` first, then promoted into a content-addressed,
 * server-derived path under the project's asset tree — the client never
 * supplies or controls a filesystem path.
 */

export type QuarantinedFile = { quarantineToken: string; sha256: string; bytes: number };

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKSUM_RE = /^[0-9a-f]{64}$/i;

const quarantineDir = () => join(mediaRoot(), "_quarantine");
const assetRelativePath = (projectId: string, checksumSha256: string, extension: string) =>
  `projects/${projectId}/assets/${checksumSha256}${extension}`;

export const sanitizeExtension = (fileName: string): string => {
  const match = /\.[a-z0-9]{1,10}$/i.exec(fileName);
  return match ? match[0].toLowerCase() : "";
};

export async function writeQuarantineFile(buffer: Buffer): Promise<QuarantinedFile> {
  const dir = quarantineDir();
  await mkdir(dir, { recursive: true });
  const token = randomUUID();
  await writeFile(join(dir, token), buffer);
  return { quarantineToken: token, sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.byteLength };
}

/** Default cap for a streamed client upload (long source videos); override with env `MEDIA_UPLOAD_MAX_BYTES`. */
export const DEFAULT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const uploadMaxBytes = (env: Record<string, string | undefined> = process.env): number => {
  const value = Number(env.MEDIA_UPLOAD_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_UPLOAD_MAX_BYTES;
};

/**
 * Streams a (possibly very large) upload into `_quarantine/<uuid>` without buffering it in memory, hashing it on the
 * way. Aborts and deletes the partial file the moment `maxBytes` is exceeded. `head` is the first 64 bytes, enough to
 * sniff the real media type before anything is registered.
 */
export async function writeQuarantineStream(
  source: AsyncIterable<Buffer | Uint8Array>,
  maxBytes: number,
): Promise<(QuarantinedFile & { head: Buffer }) | "too_large"> {
  const dir = quarantineDir();
  await mkdir(dir, { recursive: true });
  const token = randomUUID();
  const path = join(dir, token);
  const hash = createHash("sha256");
  const out = createWriteStream(path);
  let bytes = 0;
  const headChunks: Buffer[] = [];
  let headLength = 0;
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        out.destroy();
        await rm(path, { force: true });
        return "too_large";
      }
      if (headLength < 64) { headChunks.push(buffer.subarray(0, 64 - headLength)); headLength += Math.min(buffer.byteLength, 64 - headLength); }
      hash.update(buffer);
      if (!out.write(buffer)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => (error ? reject(error) : resolve())); });
  } catch (error) {
    out.destroy();
    await rm(path, { force: true });
    throw error;
  }
  return { quarantineToken: token, sha256: hash.digest("hex"), bytes, head: Buffer.concat(headChunks) };
}

export async function discardQuarantineFile(token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  await rm(join(quarantineDir(), token), { force: true });
}

export async function readQuarantineFile(token: string): Promise<Buffer> {
  if (!TOKEN_RE.test(token)) throw new Error("invalid_quarantine_token");
  return readFile(join(quarantineDir(), token));
}

/** Move a quarantined file into project storage at a checksum-derived path. Never trusts a client path. */
export async function promoteQuarantineFileToProjectAsset(input: {
  quarantineToken: string;
  projectId: string;
  checksumSha256: string;
  originalFileName: string;
}): Promise<{ relativePath: string }> {
  if (!TOKEN_RE.test(input.quarantineToken)) throw new Error("invalid_quarantine_token");
  if (!CHECKSUM_RE.test(input.checksumSha256)) throw new Error("invalid_checksum");
  const extension = sanitizeExtension(input.originalFileName);
  const relativePath = assetRelativePath(input.projectId, input.checksumSha256.toLowerCase(), extension);
  if (!isSafeRelativePath(relativePath)) throw new Error("unsafe_relative_path");
  const dest = join(mediaRoot(), relativePath);
  const src = join(quarantineDir(), input.quarantineToken);
  await mkdir(dirname(dest), { recursive: true });
  const alreadyStored = await stat(dest).then(() => true).catch(() => false);
  if (alreadyStored) {
    await rm(src, { force: true }); // duplicate checksum: reuse the already-stored bytes, drop the quarantine copy
  } else {
    await rename(src, dest);
  }
  return { relativePath };
}
