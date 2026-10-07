import type { ErrorEnvelope, UrlIntakeRequest, UrlIntakeResponse, UrlIntakeRewrite, UrlIntakeRewriteRequest, UrlIntakeStage, UrlIntakeStreamEvent } from "@lyonix/contracts";
import { API_ORIGIN, ApiError, api, csrfHeaders } from "../api";

/** VE2E-96: reads a pasted URL (TikTok transcript / article) into clean source text; with `rewrite`, also writes the script. */
export const analyzeIntakeUrl = async (request: UrlIntakeRequest): Promise<UrlIntakeResponse> =>
  api<UrlIntakeResponse>("/intake/url", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(request) });

/**
 * Same as `analyzeIntakeUrl`, with real progress: the server streams one line per stage (reading the source, subtitles, speech-to-text)
 * as it starts, then the result. A 401 refreshes the session once, like `api()`.
 */
export async function analyzeIntakeUrlStream(request: UrlIntakeRequest, onStage: (stage: UrlIntakeStage) => void, retried = false): Promise<UrlIntakeResponse> {
  const response = await fetch(`${API_ORIGIN}/api/v1/intake/url/stream`, {
    method: "POST",
    credentials: "include",
    headers: { ...(await csrfHeaders()), "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(request),
  });
  if (response.status === 401 && !retried) {
    const refreshed = await fetch(`${API_ORIGIN}/api/v1/auth/refresh`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
    if (refreshed.ok) return analyzeIntakeUrlStream(request, onStage, true);
  }
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as ErrorEnvelope | null;
    throw new ApiError(body?.error.code ?? "PROVIDER_UNAVAILABLE", body?.error.message ?? "Không thể kết nối API");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of done && buffered ? [...lines, buffered] : lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as UrlIntakeStreamEvent;
      if (event.type === "stage") onStage(event.stage);
      else if (event.type === "result") return event.data;
      else throw new ApiError(event.error.code, event.error.message);
    }
    if (done) break;
  }
  throw new ApiError("PROVIDER_UNAVAILABLE", "Không nhận được kết quả phân tích");
}

/** VE2E-96: (re)writes an original script from an already analysed source - no second download / transcription. */
export const rewriteIntakeSource = async (request: UrlIntakeRewriteRequest): Promise<UrlIntakeRewrite> =>
  api<UrlIntakeRewrite>("/intake/rewrite", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(request) });
