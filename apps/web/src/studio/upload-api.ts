import type { ErrorEnvelope, MediaAssetVersionSummary, Success } from "@lyonix/contracts";
import { API_ORIGIN, ApiError, csrfHeaders } from "../api";

export type LocalMediaMeta = { kind: "video" | "image"; durationMs: number | null; widthPx: number | null; heightPx: number | null };

/** Reads duration/dimensions in the browser (the API never runs FFmpeg/ffprobe in a request). */
export function readLocalMediaMeta(file: File): Promise<LocalMediaMeta> {
  const isVideo = file.type.startsWith("video/");
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const done = (meta: LocalMediaMeta) => { URL.revokeObjectURL(url); resolve(meta); };
    const fallback: LocalMediaMeta = { kind: isVideo ? "video" : "image", durationMs: null, widthPx: null, heightPx: null };
    if (isVideo) {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => done({ kind: "video", durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null, widthPx: video.videoWidth || null, heightPx: video.videoHeight || null });
      video.onerror = () => done(fallback);
      video.src = url;
    } else {
      const image = new Image();
      image.onload = () => done({ kind: "image", durationMs: null, widthPx: image.naturalWidth || null, heightPx: image.naturalHeight || null });
      image.onerror = () => done(fallback);
      image.src = url;
    }
  });
}

/** Streams the raw file to `POST /projects/:id/media-assets/upload` with progress (XHR: fetch has no upload progress). */
export async function uploadMediaFile(
  projectId: string,
  file: File,
  meta: LocalMediaMeta,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<MediaAssetVersionSummary> {
  const csrf = await csrfHeaders();
  const params = new URLSearchParams({ fileName: file.name });
  if (meta.durationMs) params.set("durationMs", String(meta.durationMs));
  if (meta.widthPx) params.set("widthPx", String(meta.widthPx));
  if (meta.heightPx) params.set("heightPx", String(meta.heightPx));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_ORIGIN}/api/v1/projects/${projectId}/media-assets/upload?${params.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-csrf-token", csrf["x-csrf-token"]);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new ApiError("PROVIDER_UNAVAILABLE", "Không thể kết nối API"));
    xhr.onabort = () => reject(new ApiError("CANCELLED", "Đã huỷ upload"));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as Success<MediaAssetVersionSummary> | ErrorEnvelope;
        if (xhr.status >= 200 && xhr.status < 300 && "data" in body) { onProgress(1); resolve(body.data); return; }
        const error = (body as ErrorEnvelope).error;
        reject(new ApiError(error?.code ?? "PROVIDER_UNAVAILABLE", error?.message ?? "Upload thất bại"));
      } catch {
        reject(new ApiError("PROVIDER_UNAVAILABLE", "Upload thất bại"));
      }
    };
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
