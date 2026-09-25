import type { ErrorEnvelope, Success } from "@lyonix/contracts";

export const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const isAuthPath = (path: string) => path === "/auth/login" || path === "/auth/refresh" || path === "/auth/logout";

async function parseError(response: Response) {
  const body = await response.json().catch(() => null) as ErrorEnvelope | null;
  return new ApiError(body?.error.code ?? "PROVIDER_UNAVAILABLE", body?.error.message ?? "Không thể kết nối API");
}

async function readSuccess<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return (JSON.parse(text) as Success<T>).data;
}

export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${API_ORIGIN}/api/v1${path}`, { ...init, credentials: "include", headers });
  if (response.status === 401 && !retried && !isAuthPath(path)) {
    const refreshed = await fetch(`${API_ORIGIN}/api/v1/auth/refresh`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" });
    if (refreshed.ok) return api<T>(path, init, true);
  }
  if (!response.ok) throw await parseError(response);
  return readSuccess<T>(response);
}

export async function csrfHeaders() {
  const csrf = await api<{ csrfToken: string }>("/auth/csrf");
  return { "x-csrf-token": csrf.csrfToken };
}

export type ApiMe = {
  id: string; email: string; displayName: string; role: "admin" | "staff";
  preferences: { uiLocale: "vi" | "en" | "ja" | "ko"; theme: "light" | "dark" | "system"; timezone: string };
  grants: { teamIds: string[]; projectIds: string[]; channelIds: string[] }; version: number;
  tokenType?: "Bearer"; expiresIn?: number; accessToken?: string;
};
