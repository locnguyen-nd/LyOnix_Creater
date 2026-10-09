import type { PublicBaseUrlCheck } from "./public-base-url.js";
import type { WorkerHealth } from "./worker-health.js";

/**
 * Render reliability: everything an Auto job needs, checked BEFORE it is submitted (and again server-side at submit / retry), so
 * a job that cannot finish is refused with the exact reason and fix instead of spending script / TTS / media and failing later
 * (or sitting in `draft` because no worker runs). Pure: `AutoPreflightService` gathers the facts.
 */
export type PreflightKey = "worker" | "media_worker" | "render_account" | "template" | "public_base_url" | "scene_count" | "slots" | "content" | "voice" | "media";
export type PreflightCheck = { key: PreflightKey; ok: boolean; severity: "block" | "warn"; message: string; fix: string | null };
export type AutoPreflightResult = { ok: boolean; checkedAt: string; checks: PreflightCheck[] };

export type AccountFact = { ok: true; label: string } | { ok: false; message: string };

export type AutoPreflightFacts = {
  workers: WorkerHealth;
  renderAccount: AccountFact & { provider?: string };
  /** `engine` = how the job will render; `providerRender` = a paid provider may render it (directly or as fallback). */
  template:
    | { ok: true; name: string; engine: "lyonix" | "creatomate" | "orshot"; providerRender: "always" | "fallback" | "never"; videoSlots: number; imageSlots: number; orshotPages: number | null }
    | { ok: false; message: string };
  /** null = not needed (the job renders on the internal engine only). */
  publicBaseUrl: PublicBaseUrlCheck | null;
  requestedSceneCount: number | null;
  content: { ok: true; models: string[] } | { ok: false; message: string; retryAt: string | null };
  voice: AccountFact;
  media: AccountFact;
  now: Date;
};

const pass = (key: PreflightKey, message: string): PreflightCheck => ({ key, ok: true, severity: "block", message, fix: null });
const block = (key: PreflightKey, message: string, fix: string | null): PreflightCheck => ({ key, ok: false, severity: "block", message, fix });
const warn = (key: PreflightKey, message: string, fix: string | null): PreflightCheck => ({ key, ok: false, severity: "warn", message, fix });

const clock = (iso: string) => `${iso.replace("T", " ").slice(0, 16)} UTC`;

export function evaluateAutoPreflight(facts: AutoPreflightFacts): AutoPreflightResult {
  const checks: PreflightCheck[] = [];
  const { workers } = facts;

  checks.push(workers.workflow.up
    ? pass("worker", "Worker xử lý video đang chạy.")
    : block("worker", "Worker xử lý video (apps/worker) không chạy: job sẽ chỉ nằm chờ trong hàng đợi.", "Chạy `corepack pnpm --filter @lyonix/worker dev` (hoặc `corepack pnpm dev` ở thư mục gốc) rồi thử lại."));
  checks.push(workers.mediaWorker.up === true
    ? pass("media_worker", "Media-worker (FFmpeg) đang chạy.")
    : block("media_worker", workers.mediaWorker.up === null ? "Không kết nối được RabbitMQ để kiểm tra media-worker (cắt clip / render)." : "Media-worker (FFmpeg) không chạy: không cắt được clip, không render được.", workers.mediaWorker.up === null ? "Bật RabbitMQ (docker compose) rồi chạy lại worker." : "Chạy apps/worker (gồm media-worker) và kiểm tra FFMPEG_PATH."));

  checks.push(facts.renderAccount.ok ? pass("render_account", `Tài khoản render: ${facts.renderAccount.label}.`) : block("render_account", facts.renderAccount.message, "Chọn tài khoản render khác hoặc verify lại trong Cài đặt › Provider."));

  const template = facts.template;
  if (!template.ok) {
    checks.push(block("template", template.message, "Chọn template khác (tương thích với tài khoản render đang chọn) hoặc nhờ admin bật render cho template này."));
  } else {
    checks.push(pass("template", `Template "${template.name}" render được (${template.engine === "lyonix" ? "LyOnix trên máy" : template.engine}).`));
    if (template.engine !== "lyonix" && template.videoSlots + template.imageSlots === 0) {
      checks.push(block("slots", "Template không có slot video/ảnh nào để gán media của cảnh.", "Chọn template khác có slot video/ảnh."));
    } else {
      checks.push(pass("slots", template.engine === "lyonix" ? "Recipe LyOnix tự dựng media + phụ đề cho từng cảnh." : `Slot media: ${template.videoSlots} video, ${template.imageSlots} ảnh.`));
    }
    const scenes = facts.requestedSceneCount;
    if (template.orshotPages !== null && scenes !== null && scenes > template.orshotPages) {
      checks.push(block("scene_count", `Template Orshot chỉ có ${template.orshotPages} page nhưng job muốn ${scenes} cảnh: các cảnh dư sẽ không render được.`, `Giảm số cảnh xuống tối đa ${template.orshotPages} hoặc chọn template nhiều page hơn.`));
    } else {
      checks.push(pass("scene_count", template.orshotPages !== null ? `Tối đa ${template.orshotPages} cảnh (số page của template).` : "Template co giãn theo số cảnh của kịch bản (không mất cảnh)."));
    }
  }

  const publicBase = facts.publicBaseUrl;
  if (publicBase) {
    const fallbackOnly = template.ok && template.providerRender === "fallback";
    if (!publicBase.ok) {
      checks.push(fallbackOnly
        ? warn("public_base_url", `${publicBase.message} Render dự phòng qua provider sẽ không chạy được.`, "Sửa PUBLIC_BASE_URL nếu cần render dự phòng.")
        : block("public_base_url", publicBase.message, "Mở tunnel (cloudflared) hoặc dùng domain công khai, cập nhật PUBLIC_BASE_URL rồi khởi động lại API + worker."));
    } else if (publicBase.warning) {
      checks.push(warn("public_base_url", publicBase.warning, "Dùng named tunnel hoặc domain cố định cho cấu hình lâu dài."));
    } else {
      checks.push(pass("public_base_url", "PUBLIC_BASE_URL truy cập được từ internet."));
    }
  }

  const content = facts.content;
  checks.push(content.ok
    ? pass("content", `Model viết kịch bản sẵn sàng: ${content.models.slice(0, 3).join(", ")}.`)
    : block("content", content.retryAt ? `${content.message} Dùng lại được từ ${clock(content.retryAt)}.` : content.message, content.retryAt ? "Đợi tới thời điểm trên, chọn model khác trong Cài đặt › Provider, hoặc thêm key có billing." : "Thêm hoặc verify tài khoản content trong Cài đặt › Provider."));
  checks.push(facts.voice.ok ? pass("voice", `Giọng đọc: ${facts.voice.label}.`) : block("voice", facts.voice.message, "Chọn tài khoản giọng đọc đã verify và một giọng."));
  checks.push(facts.media.ok ? pass("media", `Nguồn media: ${facts.media.label}.`) : block("media", facts.media.message, "Bật hoặc verify tài khoản media (Pexels/Apify) trong Cài đặt › Provider."));

  return { ok: checks.every((check) => check.ok || check.severity === "warn"), checkedAt: facts.now.toISOString(), checks };
}

/** The first blocking failure as one sentence (submit / retry refusals). */
export const preflightRefusal = (result: AutoPreflightResult): string | null => {
  const failed = result.checks.filter((check) => !check.ok && check.severity === "block");
  if (failed.length === 0) return null;
  return failed.map((check) => `${check.message}${check.fix ? ` → ${check.fix}` : ""}`).join(" | ");
};
