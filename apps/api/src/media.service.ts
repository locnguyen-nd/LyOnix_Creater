import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@lyonix/db";
import type { MediaAssetKind, MediaAssetVersionSummary, MediaFolderSummary, MediaOrigin, PexelsAttribution } from "@lyonix/contracts";
import { canAccessProject, computeExpiresAt, findDuplicateReusableAsset, isSafeSegmentName, isSha256Hex } from "@lyonix/domain";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { promoteQuarantineFileToProjectAsset, readQuarantineFile, writeQuarantineFile } from "./quarantine.js";
import { fetchBinarySafely } from "./safe-binary-fetch.js";

export type CreateFolderInput = { name: string; parentId?: string | null };
export type ImportFromUrlInput = { url: string; folderId?: string | null; reusable?: boolean; kind?: MediaAssetKind };

/** Generic external URL import cap (photo/video/document) — separate from any provider-specific limit. */
const MAX_IMPORT_URL_BYTES = 80 * 1024 * 1024;

const kindFromMimeType = (mimeType: string): MediaAssetKind => {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
};

export type RegisterAssetInput = {
  quarantineToken: string;
  kind: MediaAssetKind;
  originalFileName: string;
  mimeType: string;
  checksumSha256: string;
  bytes: number;
  widthPx?: number | null;
  heightPx?: number | null;
  durationMs?: number | null;
  origin: MediaOrigin;
  license?: string | null;
  reusable?: boolean;
  folderId?: string | null;
  sceneId?: string | null;
  /** Only meaningful for `origin==="pexels"` — merged into the stored `provenance` JSON, never dropped. */
  attribution?: PexelsAttribution | null;
};

const KIND_PREFIX: Record<MediaAssetKind, string> = { image: "image/", video: "video/", audio: "audio/", document: "" };

const mimeMatchesKind = (mimeType: string, kind: MediaAssetKind) => {
  const prefix = KIND_PREFIX[kind];
  if (!prefix) return true; // document kind accepts any non image/video/audio mime by convention
  return mimeType.toLowerCase().startsWith(prefix);
};

/** Sniff supported media from bytes; external Content-Type is only a hint, never proof. */
export const sniffMediaMimeType = (bytes: Buffer): string | null => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (bytes.subarray(0, 4).toString("ascii") === "fLaC") return "audio/flac";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
};

const normalizedMime = (value: string) => value.trim().toLowerCase().split(";")[0];

const toFolderSummary = (row: { id: string; projectId: string; parentId: string | null; name: string }): MediaFolderSummary => ({
  id: row.id,
  projectId: row.projectId,
  parentId: row.parentId,
  name: row.name,
});

const attributionFromProvenance = (provenance: unknown): PexelsAttribution | null => {
  const value = (provenance ?? {}) as Record<string, unknown>;
  const attribution = value.attribution as Record<string, unknown> | undefined;
  if (!attribution) return null;
  return {
    photographerName: typeof attribution.photographerName === "string" ? attribution.photographerName : "",
    photographerUrl: typeof attribution.photographerUrl === "string" ? attribution.photographerUrl : "",
    pexelsPageUrl: typeof attribution.pexelsPageUrl === "string" ? attribution.pexelsPageUrl : "",
  };
};

const toAssetSummary = (row: {
  id: string; projectId: string; folderId: string | null; kind: string; originalFileName: string; mimeType: string;
  checksumSha256: string; bytes: number; widthPx: number | null; heightPx: number | null; durationMs: number | null;
  origin: string; license: string | null; reusable: boolean; retentionClass: string; expiresAt: Date | null; version: number; createdAt: Date;
  sceneId?: string | null; provenance?: unknown;
}): MediaAssetVersionSummary => ({
  id: row.id,
  projectId: row.projectId,
  folderId: row.folderId,
  kind: row.kind as MediaAssetKind,
  originalFileName: row.originalFileName,
  mimeType: row.mimeType,
  checksumSha256: row.checksumSha256,
  bytes: row.bytes,
  widthPx: row.widthPx,
  heightPx: row.heightPx,
  durationMs: row.durationMs,
  origin: row.origin as MediaOrigin,
  license: row.license,
  reusable: row.reusable,
  retentionClass: row.retentionClass as "project" | "working",
  expiresAt: row.expiresAt?.toISOString() ?? null,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  sceneId: row.sceneId ?? null,
  attribution: attributionFromProvenance(row.provenance),
});

@Injectable()
export class MediaService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  private async assertAccess(projectId: string, userId: string, role: "admin" | "staff") {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return null;
    const grants = await this.grants.forUser(userId, role);
    if (!canAccessProject(role, grants, projectId)) return null;
    return project;
  }

  async listFolders(projectId: string, userId: string, role: "admin" | "staff") {
    if (!(await this.assertAccess(projectId, userId, role))) return "forbidden" as const;
    const rows = await this.prisma.mediaFolder.findMany({ where: { projectId }, orderBy: { name: "asc" } });
    return rows.map(toFolderSummary);
  }

  async createFolder(projectId: string, userId: string, role: "admin" | "staff", input: CreateFolderInput) {
    if (!(await this.assertAccess(projectId, userId, role))) return "forbidden" as const;
    const name = input.name.trim();
    if (!isSafeSegmentName(name)) return "invalid" as const;
    if (input.parentId) {
      const parent = await this.prisma.mediaFolder.findFirst({ where: { id: input.parentId, projectId } });
      if (!parent) return "invalid" as const;
    }
    const existing = await this.prisma.mediaFolder.findFirst({ where: { projectId, parentId: input.parentId ?? null, name } });
    if (existing) return toFolderSummary(existing);
    const row = await this.prisma.mediaFolder.create({ data: { projectId, parentId: input.parentId ?? null, name } });
    return toFolderSummary(row);
  }

  async listAssets(projectId: string, userId: string, role: "admin" | "staff", folderId?: string) {
    if (!(await this.assertAccess(projectId, userId, role))) return "forbidden" as const;
    const rows = await this.prisma.mediaAssetVersion.findMany({
      where: { projectId, deletedAt: null, ...(folderId === undefined ? {} : { folderId: folderId || null }) },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toAssetSummary);
  }

  async registerAsset(projectId: string, userId: string, role: "admin" | "staff", input: RegisterAssetInput) {
    if (!(await this.assertAccess(projectId, userId, role))) return "forbidden" as const;
    if (!isSha256Hex(input.checksumSha256)) return "invalid" as const;
    if (!input.originalFileName.trim() || !input.mimeType.trim() || input.bytes <= 0) return "invalid" as const;
    let actualBytes: Buffer;
    try { actualBytes = await readQuarantineFile(input.quarantineToken); } catch { return "quarantine_missing" as const; }
    const actualChecksum = createHash("sha256").update(actualBytes).digest("hex");
    const sniffedMime = sniffMediaMimeType(actualBytes);
    const claimedMime = normalizedMime(input.mimeType);
    if (actualBytes.byteLength !== input.bytes || actualChecksum !== input.checksumSha256.toLowerCase()) return "invalid" as const;
    if (!sniffedMime || !mimeMatchesKind(sniffedMime, input.kind) || (claimedMime !== "application/octet-stream" && claimedMime !== sniffedMime)) return "unsupported_media" as const;
    if (input.folderId) {
      const folder = await this.prisma.mediaFolder.findFirst({ where: { id: input.folderId, projectId } });
      if (!folder) return "invalid" as const;
    }
    const reusable = input.reusable ?? true;
    if (reusable) {
      const existing = await this.prisma.mediaAssetVersion.findMany({
        where: { projectId, reusable: true, deletedAt: null },
        select: { id: true, checksumSha256: true, reusable: true, deletedAt: true },
      });
      const duplicate = findDuplicateReusableAsset(input.checksumSha256.toLowerCase(), existing);
      if (duplicate) {
        const row = await this.prisma.mediaAssetVersion.findUnique({ where: { id: duplicate.id } });
        return row ? toAssetSummary(row) : "invalid" as const;
      }
    }
    let relativePath: string;
    try {
      const promoted = await promoteQuarantineFileToProjectAsset({
        quarantineToken: input.quarantineToken,
        projectId,
        checksumSha256: input.checksumSha256.toLowerCase(),
        originalFileName: input.originalFileName,
      });
      relativePath = promoted.relativePath;
    } catch {
      return "quarantine_missing" as const;
    }
    const retentionClass = reusable ? "project" as const : "working" as const;
    const row = await this.prisma.mediaAssetVersion.create({
      data: {
        projectId,
        folderId: input.folderId ?? null,
        kind: input.kind,
        originalFileName: input.originalFileName.trim(),
        mimeType: sniffedMime,
        checksumSha256: input.checksumSha256.toLowerCase(),
        bytes: input.bytes,
        widthPx: input.widthPx ?? null,
        heightPx: input.heightPx ?? null,
        durationMs: input.durationMs ?? null,
        origin: input.origin,
        license: input.license ?? null,
        provenance: {
          origin: input.origin,
          registeredBy: userId,
          ...(input.attribution ? { attribution: input.attribution } : {}),
        } as Prisma.InputJsonValue,
        reusable,
        retentionClass,
        relativePath,
        sceneId: input.sceneId ?? null,
        expiresAt: computeExpiresAt(retentionClass),
        createdByUserId: userId,
      },
    });
    return toAssetSummary(row);
  }

  /** Simple scene assignment/replacement (VE2E-04): attach or clear an opaque `sceneId` on an existing asset. No FK/orchestration — see schema comment on `MediaAssetVersion.sceneId`. */
  async assignScene(id: string, userId: string, role: "admin" | "staff", sceneId: string | null) {
    const row = await this.prisma.mediaAssetVersion.findFirst({ where: { id, deletedAt: null } });
    if (!row) return null;
    if (!(await this.assertAccess(row.projectId, userId, role))) return "forbidden" as const;
    const updated = await this.prisma.mediaAssetVersion.update({ where: { id }, data: { sceneId: sceneId?.trim() || null } });
    return toAssetSummary(updated);
  }

  /**
   * Import media into the project library from an arbitrary external URL
   * (upload-by-URL) — still goes through the SSRF guard + quarantine flow
   * (`fetchBinarySafely`, redirect-hop re-validated, size-capped), never trusts
   * a client-declared MIME type over the bytes it downloaded, and re-uses
   * `registerAsset` for the actual storage/dedupe/retention logic instead of a
   * parallel path.
   */
  async importFromUrl(projectId: string, userId: string, role: "admin" | "staff", input: ImportFromUrlInput) {
    if (!(await this.assertAccess(projectId, userId, role))) return "forbidden" as const;
    const downloaded = await fetchBinarySafely(input.url, { maxBytes: MAX_IMPORT_URL_BYTES });
    if (!downloaded.ok) return downloaded.reason;
    if (downloaded.buffer.byteLength === 0) return "invalid" as const;
    const sniffedMime = sniffMediaMimeType(downloaded.buffer);
    if (!sniffedMime) return "unsupported_media" as const;
    const mimeType = sniffedMime;
    const kind = input.kind ?? kindFromMimeType(mimeType);
    const checksumSha256 = createHash("sha256").update(downloaded.buffer).digest("hex");
    const quarantined = await writeQuarantineFile(downloaded.buffer);
    const originalFileName = (() => {
      try {
        return decodeURIComponent(new URL(downloaded.finalUrl).pathname.split("/").pop() || "") || "imported-file";
      } catch {
        return "imported-file";
      }
    })();
    return this.registerAsset(projectId, userId, role, {
      quarantineToken: quarantined.quarantineToken,
      kind,
      originalFileName,
      mimeType,
      checksumSha256,
      bytes: downloaded.buffer.byteLength,
      origin: "import_url",
      reusable: input.reusable ?? true,
      folderId: input.folderId ?? null,
    });
  }

  async removeAsset(id: string, userId: string, role: "admin" | "staff") {
    const row = await this.prisma.mediaAssetVersion.findFirst({ where: { id, deletedAt: null } });
    if (!row) return null;
    if (!(await this.assertAccess(row.projectId, userId, role))) return "forbidden" as const;
    await this.prisma.mediaAssetVersion.update({ where: { id }, data: { deletedAt: new Date() } });
    return true as const;
  }
}
