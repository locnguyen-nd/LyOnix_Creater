/**
 * Render reliability: can a render provider (Creatomate / Orshot) fetch our media through PUBLIC_BASE_URL right now?
 * Providers download every scene file from `<PUBLIC_BASE_URL>/api/v1/media-delivery/<token>`, so a missing, local or dead
 * URL (an expired `trycloudflare.com` dev tunnel) fails the render minutes later with "A file could not be downloaded".
 * This check runs BEFORE any paid step: syntax (set, http(s), not loopback / private) and - outside tests - one GET of our own
 * `/api/v1/health` through the public URL (short timeout, cached briefly). It never sends a token or media.
 */
export type PublicBaseUrlProblem = "NOT_CONFIGURED" | "INVALID_URL" | "NOT_PUBLIC" | "UNREACHABLE";

export type PublicBaseUrlCheck =
  | { ok: true; baseUrl: string; probed: boolean; checkedAt: string; warning: string | null }
  | { ok: false; problem: PublicBaseUrlProblem; baseUrl: string | null; probed: boolean; checkedAt: string; message: string };

export const PUBLIC_BASE_URL_MESSAGES: Record<PublicBaseUrlProblem, string> = {
  NOT_CONFIGURED: "PUBLIC_BASE_URL chưa cấu hình: Creatomate/Orshot cần một URL công khai để tải media của từng cảnh. Đặt PUBLIC_BASE_URL (tunnel cloudflared khi dev, domain thật khi chạy thật) rồi khởi động lại API + worker.",
  INVALID_URL: "PUBLIC_BASE_URL không phải URL http(s) hợp lệ. Sửa giá trị trong .env rồi khởi động lại API + worker.",
  NOT_PUBLIC: "PUBLIC_BASE_URL đang trỏ vào máy local / mạng nội bộ: Creatomate/Orshot không tải được media từ đó. Dùng tunnel (cloudflared) hoặc domain công khai.",
  UNREACHABLE: "PUBLIC_BASE_URL không truy cập được từ internet (tunnel đã tắt hoặc hết hạn?): Creatomate/Orshot sẽ không tải được media. Mở lại tunnel, cập nhật PUBLIC_BASE_URL rồi khởi động lại API + worker.",
};

const TEMPORARY_TUNNEL = /\.trycloudflare\.com$/i;

/** Loopback, link-local and RFC 1918 hosts a provider on the internet can never reach. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost") || name === "::1" || name === "0.0.0.0") return true;
  const parts = name.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

export type PublicBaseUrlOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Probe reachability over the network. Default: on, except under tests (`NODE_ENV=test`) or `PUBLIC_BASE_URL_PROBE=0`. */
  probe?: boolean;
  now?: () => Date;
};

const cache = new Map<string, { at: number; result: PublicBaseUrlCheck }>();
const CACHE_OK_MS = 30_000;
const CACHE_FAIL_MS = 10_000;

/** Test hook: forget cached probes. */
export const resetPublicBaseUrlCache = () => cache.clear();

export async function checkPublicBaseUrl(options: PublicBaseUrlOptions = {}): Promise<PublicBaseUrlCheck> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const checkedAt = () => now().toISOString();
  const raw = env.PUBLIC_BASE_URL?.trim() ?? "";
  if (!raw) return { ok: false, problem: "NOT_CONFIGURED", baseUrl: null, probed: false, checkedAt: checkedAt(), message: PUBLIC_BASE_URL_MESSAGES.NOT_CONFIGURED };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: "INVALID_URL", baseUrl: raw, probed: false, checkedAt: checkedAt(), message: PUBLIC_BASE_URL_MESSAGES.INVALID_URL };
  }
  const baseUrl = raw.replace(/\/+$/, "");
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, problem: "INVALID_URL", baseUrl, probed: false, checkedAt: checkedAt(), message: PUBLIC_BASE_URL_MESSAGES.INVALID_URL };
  if (isLocalHost(url.hostname)) return { ok: false, problem: "NOT_PUBLIC", baseUrl, probed: false, checkedAt: checkedAt(), message: PUBLIC_BASE_URL_MESSAGES.NOT_PUBLIC };
  const warning = TEMPORARY_TUNNEL.test(url.hostname) ? "PUBLIC_BASE_URL là tunnel tạm (trycloudflare): URL đổi mỗi lần mở tunnel, không dùng làm cấu hình ổn định." : null;

  const probe = options.probe ?? (env.NODE_ENV !== "test" && env.PUBLIC_BASE_URL_PROBE !== "0");
  if (!probe) return { ok: true, baseUrl, probed: false, checkedAt: checkedAt(), warning };

  const cached = cache.get(baseUrl);
  const nowMs = now().getTime();
  if (cached && nowMs - cached.at < (cached.result.ok ? CACHE_OK_MS : CACHE_FAIL_MS)) return cached.result;
  const fetchImpl = options.fetchImpl ?? fetch;
  let result: PublicBaseUrlCheck;
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/health`, { method: "GET", signal: AbortSignal.timeout(options.timeoutMs ?? 6_000), headers: { accept: "application/json" } });
    const body = response.ok ? await response.json().catch(() => null) as { data?: { status?: unknown; service?: unknown } } | null : null;
    const ours = body?.data?.status === "ok" && body.data.service === "api";
    result = ours
      ? { ok: true, baseUrl, probed: true, checkedAt: checkedAt(), warning }
      : { ok: false, problem: "UNREACHABLE", baseUrl, probed: true, checkedAt: checkedAt(), message: `${PUBLIC_BASE_URL_MESSAGES.UNREACHABLE} (HTTP ${response.status}${response.ok ? ", không phải API LyOnix" : ""})` };
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "lỗi kết nối";
    result = { ok: false, problem: "UNREACHABLE", baseUrl, probed: true, checkedAt: checkedAt(), message: `${PUBLIC_BASE_URL_MESSAGES.UNREACHABLE} (${reason})` };
  }
  cache.set(baseUrl, { at: nowMs, result });
  return result;
}
