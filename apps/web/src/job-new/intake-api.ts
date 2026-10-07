import type { UrlIntakeRequest, UrlIntakeResponse, UrlIntakeRewrite, UrlIntakeRewriteRequest } from "@lyonix/contracts";
import { api, csrfHeaders } from "../api";

/** VE2E-96: reads a pasted URL (TikTok transcript / article) into clean source text; with `rewrite`, also writes the script. */
export const analyzeIntakeUrl = async (request: UrlIntakeRequest): Promise<UrlIntakeResponse> =>
  api<UrlIntakeResponse>("/intake/url", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(request) });

/** VE2E-96: (re)writes an original script from an already analysed source - no second download / transcription. */
export const rewriteIntakeSource = async (request: UrlIntakeRewriteRequest): Promise<UrlIntakeRewrite> =>
  api<UrlIntakeRewrite>("/intake/rewrite", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify(request) });
