/**
 * Template catalog audit (render readiness): for every template a user can see in the picker, can it really render, with which
 * engine, how many scenes, which slots, captions, and - when not - exactly why. Pure: `template-audit-main.ts` gathers the rows
 * (DB snapshots, the live Creatomate template list, the internal recipes, the render queue) and prints the result.
 */
export type AuditStatus = "ready" | "limited" | "incompatible";

export type SlotCounts = { video: number; image: number; text: number; audio: number; other: number; required: number };

export type TemplateAuditRow = {
  provider: "lyonix" | "creatomate" | "orshot";
  externalTemplateId: string;
  name: string;
  /** Latest pinned snapshot (what Auto / Studio render), null = never pinned. */
  snapshotId: string | null;
  /** Share of the readiness checks that pass (0..100). */
  readinessPct: number;
  status: AuditStatus;
  /** `elastic`: any scene count renders (scenes are generated from the template's scene layout or the recipe). */
  sceneSupport: { mode: "elastic" | "fixed"; templateSceneSlots: number | null; note: string };
  slots: SlotCounts;
  captions: "voice_timed" | "none";
  compatibleRenderAccounts: string[];
  fallbackSnapshotIds: string[];
  rolloutPercent: number | null;
  /** Every failed check, in the user's language; empty when ready. */
  reasons: string[];
  /** Notes that do not block (limited). */
  warnings: string[];
};

export type SnapshotFacts = {
  id: string;
  externalTemplateId: string;
  name: string;
  engine: string;
  providerAccountId: string;
  rolloutPercent: number;
  fallbackSnapshotIds: string[];
  modifications: Array<{ key: string; kind: string; required: boolean }>;
  /** Root-level Scene compositions of a Creatomate template (0 = flat template). */
  sceneSlots: number;
  createdAt: Date;
};

export type CreatomateAuditInput = {
  accountId: string;
  accountUsable: boolean;
  /** Live template list from Creatomate; `error` = the list call failed (code only). */
  live: { ok: true; templates: Array<{ externalTemplateId: string; name: string; previewUrl: string | null }> } | { ok: false; code: string };
  snapshots: SnapshotFacts[];
  /** Is PUBLIC_BASE_URL reachable from the internet (Creatomate downloads every scene file from it)? */
  publicMediaReachable: boolean;
};

export type LyonixAuditInput = {
  accountId: string;
  recipes: Array<{ externalTemplateId: string; name: string; captionsEnabled: boolean; slots: Array<{ key: string; kind: string; required: boolean }> }>;
  snapshots: SnapshotFacts[];
  /** Consumers on the render queue (`lyonix.render`); null = could not be checked. */
  renderConsumers: number | null;
  /** Snapshot ids usable as provider fallback (verified Creatomate account). */
  usableFallbackIds: Set<string>;
};

const countSlots = (slots: ReadonlyArray<{ kind: string; required: boolean }>): SlotCounts => {
  const counts: SlotCounts = { video: 0, image: 0, text: 0, audio: 0, other: 0, required: 0 };
  for (const slot of slots) {
    if (slot.kind === "video" || slot.kind === "image" || slot.kind === "text" || slot.kind === "audio") counts[slot.kind] += 1;
    else counts.other += 1;
    if (slot.required) counts.required += 1;
  }
  return counts;
};

const latestByExternalId = (snapshots: readonly SnapshotFacts[]) => {
  const map = new Map<string, SnapshotFacts>();
  for (const row of snapshots) {
    const current = map.get(row.externalTemplateId);
    if (!current || row.createdAt > current.createdAt) map.set(row.externalTemplateId, row);
  }
  return map;
};

const pct = (checks: boolean[]) => Math.round((checks.filter(Boolean).length / Math.max(1, checks.length)) * 100);

export function auditCreatomate(input: CreatomateAuditInput): TemplateAuditRow[] {
  const latest = latestByExternalId(input.snapshots);
  const liveIds = input.live.ok ? new Set(input.live.templates.map((row) => row.externalTemplateId)) : null;
  const listed = input.live.ok ? input.live.templates : [...latest.values()].map((row) => ({ externalTemplateId: row.externalTemplateId, name: row.name, previewUrl: null }));
  const ids = [...new Set([...listed.map((row) => row.externalTemplateId), ...latest.keys()])];
  return ids.map((externalTemplateId) => {
    const snapshot = latest.get(externalTemplateId) ?? null;
    const name = listed.find((row) => row.externalTemplateId === externalTemplateId)?.name ?? snapshot?.name ?? externalTemplateId;
    const slots = countSlots(snapshot?.modifications ?? []);
    const existsLive = liveIds ? liveIds.has(externalTemplateId) : null;
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (!input.accountUsable) reasons.push("Tài khoản Creatomate chưa verify hoặc đã xoá.");
    if (existsLive === false) reasons.push("Template ID không còn trên Creatomate (đã xoá / đổi tài khoản).");
    if (!input.live.ok) warnings.push(`Không đọc được danh sách template từ Creatomate (${input.live.code}).`);
    if (!snapshot) warnings.push("Chưa pin snapshot: sẽ pin khi chọn template (đọc template thật từ Creatomate).");
    if (snapshot && slots.video + slots.image === 0) reasons.push("Template không có slot video/ảnh nào để gán media.");
    if (!input.publicMediaReachable) reasons.push("PUBLIC_BASE_URL không truy cập được từ internet: Creatomate không tải được media của cảnh (lỗi 'A file could not be downloaded').");
    const sceneSlots = snapshot?.sceneSlots ?? null;
    if (snapshot && sceneSlots === 0) warnings.push("Template không có cấu trúc Scene-N: chỉ render đúng khi số cảnh = số slot video/ảnh.");
    const elastic = sceneSlots === null || sceneSlots > 0;
    const checks = [input.accountUsable, existsLive !== false, Boolean(snapshot), slots.video + slots.image > 0, input.publicMediaReachable];
    return {
      provider: "creatomate" as const,
      externalTemplateId,
      name,
      snapshotId: snapshot?.id ?? null,
      readinessPct: pct(checks),
      status: reasons.length ? "incompatible" : warnings.length ? "limited" : "ready",
      sceneSupport: elastic
        ? { mode: "elastic", templateSceneSlots: sceneSlots, note: sceneSlots ? `${sceneSlots} slot cố định; số cảnh khác thì dựng động theo bố cục Scene` : "dựng động theo bố cục Scene" }
        : { mode: "fixed", templateSceneSlots: slots.video + slots.image, note: `đúng ${slots.video + slots.image} cảnh` },
      slots,
      captions: "voice_timed",
      compatibleRenderAccounts: input.accountUsable ? [input.accountId] : [],
      fallbackSnapshotIds: [],
      rolloutPercent: null,
      reasons,
      warnings,
    };
  });
}

export function auditLyonix(input: LyonixAuditInput): TemplateAuditRow[] {
  const latest = latestByExternalId(input.snapshots);
  return input.recipes.map((recipe) => {
    const snapshot = latest.get(recipe.externalTemplateId) ?? null;
    const rollout = snapshot?.rolloutPercent ?? 0;
    const fallbacks = (snapshot?.fallbackSnapshotIds ?? []).filter((id) => input.usableFallbackIds.has(id));
    const engineUp = input.renderConsumers === null ? null : input.renderConsumers > 0;
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (!snapshot) reasons.push("Recipe chưa được nạp vào kho mẫu (chưa có snapshot).");
    if (rollout === 0) reasons.push("Rollout 0 %: admin chưa bật engine LyOnix cho template này (Cài đặt › Render engine).");
    if (rollout > 0 && rollout < 100 && fallbacks.length === 0) reasons.push(`Rollout ${rollout} % cần mẫu Creatomate dự phòng nhưng chưa có mẫu dự phòng dùng được.`);
    if (engineUp === false && fallbacks.length === 0) reasons.push("Media-worker (FFmpeg) không chạy: hàng đợi lyonix.render không có consumer.");
    if (engineUp === null) warnings.push("Không kiểm tra được hàng đợi render.");
    const checks = [Boolean(snapshot), rollout > 0, rollout === 100 || fallbacks.length > 0, engineUp !== false || fallbacks.length > 0];
    return {
      provider: "lyonix" as const,
      externalTemplateId: recipe.externalTemplateId,
      name: recipe.name,
      snapshotId: snapshot?.id ?? null,
      readinessPct: pct(checks),
      status: reasons.length ? "incompatible" : warnings.length ? "limited" : "ready",
      sceneSupport: { mode: "elastic", templateSceneSlots: null, note: "mọi số cảnh (recipe dựng từng cảnh)" },
      slots: countSlots(recipe.slots),
      captions: recipe.captionsEnabled ? "voice_timed" : "none",
      compatibleRenderAccounts: [input.accountId],
      fallbackSnapshotIds: fallbacks,
      rolloutPercent: rollout,
      reasons,
      warnings,
    };
  });
}

const STATUS_LABEL: Record<AuditStatus, string> = { ready: "✓ Sẵn sàng", limited: "⚠ Giới hạn", incompatible: "✕ Không tương thích" };

export function formatTemplateAudit(rows: readonly TemplateAuditRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`${STATUS_LABEL[row.status]}  ${row.readinessPct}%  [${row.provider}] ${row.name}`);
    lines.push(`    id=${row.externalTemplateId}  snapshot=${row.snapshotId?.slice(0, 8) ?? "-"}${row.rolloutPercent === null ? "" : `  rollout=${row.rolloutPercent}%`}  fallback=${row.fallbackSnapshotIds.length}`);
    lines.push(`    cảnh: ${row.sceneSupport.mode} (${row.sceneSupport.note})  slot: video ${row.slots.video}, ảnh ${row.slots.image}, chữ ${row.slots.text}, audio ${row.slots.audio}, khác ${row.slots.other}, bắt buộc ${row.slots.required}  phụ đề: ${row.captions === "voice_timed" ? "theo giọng đọc" : "không"}`);
    for (const reason of row.reasons) lines.push(`    ✕ ${reason}`);
    for (const warning of row.warnings) lines.push(`    ⚠ ${warning}`);
  }
  const by = (status: AuditStatus) => rows.filter((row) => row.status === status).length;
  lines.push("");
  lines.push(`Tổng ${rows.length}: ${by("ready")} sẵn sàng, ${by("limited")} giới hạn, ${by("incompatible")} không tương thích`);
  return lines.join("\n");
}
