/**
 * Pure helpers for the Orshot Studio panel: embed URL, trusted postMessage parsing, template/timeline slot
 * compatibility and cost/format display. No React, no network — everything here is unit-tested.
 */
import type { OrshotRenderOptions, TemplateModificationSlotResponse } from "@lyonix/contracts";

export const ORSHOT_EMBED_ORIGIN = "https://orshot.com";
/** Orshot account stores "n/a" in `model` until an Embed ID is configured (see ProvidersPage). */
export const ORSHOT_NO_EMBED = "n/a";

const EMBED_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

/** The Embed ID the account carries, or null when unset/invalid (invalid values are never placed into a URL). */
export const orshotEmbedIdOf = (model: string | null | undefined): string | null => (model && model !== ORSHOT_NO_EMBED && EMBED_ID_RE.test(model) ? model : null);

export function buildOrshotEmbedUrl(embedId: string, opts: { templateId?: string | null; lang?: string; userId?: string | null } = {}): string | null {
  if (!EMBED_ID_RE.test(embedId)) return null;
  const params = new URLSearchParams();
  if (opts.templateId) params.set("templateId", opts.templateId);
  if (opts.lang) params.set("lang", opts.lang);
  if (opts.userId) params.set("userId", opts.userId);
  const query = params.toString();
  return `${ORSHOT_EMBED_ORIGIN}/embeds/${embedId}${query ? `?${query}` : ""}`;
}

export type OrshotEmbedEvent =
  | { kind: "ready"; eventsEnabled: boolean | null }
  | { kind: "template-created" | "template-updated" | "template-content" };

/** Accepts a message only from https://orshot.com (and, when given, the iframe's own window); anything else is dropped. */
export function parseOrshotEmbedMessage(event: { origin: string; data: unknown; source?: unknown }, frameWindow?: unknown): OrshotEmbedEvent | null {
  if (event.origin !== ORSHOT_EMBED_ORIGIN) return null;
  if (frameWindow !== undefined && event.source !== frameWindow) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "orshot:embed:ready") {
    const enabled = (record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>).eventsEnabled : record.eventsEnabled);
    return { kind: "ready", eventsEnabled: typeof enabled === "boolean" ? enabled : null };
  }
  if (type === "orshot:template:create") return { kind: "template-created" };
  if (type === "orshot:template:update") return { kind: "template-updated" };
  if (type === "orshot:template:content") return { kind: "template-content" };
  return null;
}

export type OrshotSlotKind = "video" | "image" | "text" | "audio";
export const ORSHOT_SLOT_KINDS: OrshotSlotKind[] = ["video", "image", "text", "audio"];

export type TimelineSlotSupply = { scenes: number; videos: number; images: number; voices: number };
export type SlotCompatibilityRow = { kind: OrshotSlotKind; templateSlots: number; timelineItems: number; status: "ok" | "missing" | "unused" };

/**
 * Orshot fills the pinned template's FIXED slots positionally per kind. Template slot count vs what the timeline can supply:
 * fewer items than slots → "missing" (required slots stay empty, the submit is rejected); more → "unused" (extra scenes are dropped).
 * Audio slots are optional, so a shortfall there is only "ok".
 */
export function slotCompatibility(slots: Pick<TemplateModificationSlotResponse, "kind">[], supply: TimelineSlotSupply): SlotCompatibilityRow[] {
  const count = (kind: string) => slots.filter((slot) => slot.kind === kind).length;
  const supplyOf: Record<OrshotSlotKind, number> = { video: supply.videos, image: supply.images, text: supply.scenes, audio: supply.voices };
  return ORSHOT_SLOT_KINDS.map((kind) => {
    const templateSlots = count(kind);
    const timelineItems = supplyOf[kind];
    const status = templateSlots === 0 ? (timelineItems > 0 && kind !== "text" ? "unused" : "ok") : timelineItems < templateSlots && kind !== "audio" ? "missing" : timelineItems > templateSlots ? "unused" : "ok";
    return { kind, templateSlots, timelineItems, status };
  });
}

export const hasBlockingSlotMismatch = (rows: SlotCompatibilityRow[]) => rows.some((row) => row.status === "missing");

export const ORSHOT_FORMATS: NonNullable<OrshotRenderOptions["format"]>[] = ["mp4", "webm", "mov", "gif"];
export const ORSHOT_FPS: NonNullable<OrshotRenderOptions["fps"]>[] = [24, 30, 60];
/** Keep in sync with `ORSHOT_SIZE_PRESETS` in apps/api/src/orshot-render.ts (server whitelists; unknown values are rejected). */
export const ORSHOT_SIZES = ["tiktok-video", "youtube-short", "instagram-story", "facebook-story", "whatsapp-status", "instagram-post-portrait", "instagram-post", "presentation-16-9"] as const;

export const DEFAULT_ORSHOT_OPTIONS: OrshotRenderOptions = { fitDurationToNarration: true };

/** Drops empty values so the request carries only deliberate choices. */
export function compactOrshotOptions(options: OrshotRenderOptions): OrshotRenderOptions {
  return {
    ...(options.format ? { format: options.format } : {}),
    ...(options.fps ? { fps: options.fps } : {}),
    ...(options.size ? { size: options.size } : {}),
    fitDurationToNarration: options.fitDurationToNarration !== false,
  };
}

/** "$0.1040" estimate string → "≈ $0.10"; keeps 4 decimals under a cent so tiny renders do not show as $0.00. */
export function formatUsd(amount: string | number | null | undefined): string {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (amount === null || amount === undefined || !Number.isFinite(value)) return "—";
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

/** Orshot returns no percentage: show elapsed time since the job was created instead. */
export function elapsedLabel(createdAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
