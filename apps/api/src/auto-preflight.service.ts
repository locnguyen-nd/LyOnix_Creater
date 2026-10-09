import { Inject, Injectable, Optional } from "@nestjs/common";
import { orshotPageCount } from "@lyonix/domain";
import { isLiveContentKind, rankContentModels } from "@lyonix/providers";
import { evaluateAutoPreflight, type AccountFact, type AutoPreflightFacts, type AutoPreflightResult } from "./auto-preflight.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { MediaJobsGateway, type VideoComposer } from "./media-jobs.gateway.js";
import { PrismaService } from "./prisma.service.js";
import { checkPublicBaseUrl } from "./public-base-url.js";
import { readWorkerHealth, type WorkerHealth } from "./worker-health.js";

export type AutoPreflightInput = {
  contentAccountId: string;
  voiceAccountId: string;
  voiceId: string;
  mediaAccountId: string;
  renderAccountId: string;
  /** The pinned snapshot; or, from the form before pinning, the template's external id (its latest snapshot is checked). */
  templateSnapshotId: string;
  externalTemplateId?: string;
  sceneCount?: number | null;
};

type AccountRow = { id: string; name: string; provider: string; role: string; status: string; isFake: boolean; enabled: boolean; deletedAt: Date | null };

const usable = (row: Pick<AccountRow, "status" | "isFake">) => (row.isFake ? process.env.NODE_ENV === "test" : row.status === "verified");

/**
 * Render reliability: gathers the facts of `evaluateAutoPreflight` (workers, render account + template, PUBLIC_BASE_URL when a
 * provider renders, content model availability incl. cooldowns, voice, media). Read-only: no provider is called, except the
 * PUBLIC_BASE_URL reachability probe of our own `/health`.
 */
@Injectable()
export class AutoPreflightService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(CreatomateTemplatesService) private readonly templates?: CreatomateTemplatesService,
    @Optional() @Inject(MediaJobsGateway) private readonly composer?: VideoComposer,
  ) {}

  private findSnapshot(input: AutoPreflightInput) {
    const select = { id: true, name: true, engine: true, modifications: true, rolloutPercent: true, fallbackSnapshotIds: true } as const;
    if (input.templateSnapshotId) return this.prisma.templateSnapshot.findUnique({ where: { id: input.templateSnapshotId }, select });
    if (input.externalTemplateId && input.renderAccountId) {
      return this.prisma.templateSnapshot.findFirst({ where: { providerAccountId: input.renderAccountId, externalTemplateId: input.externalTemplateId }, orderBy: { createdAt: "desc" }, select });
    }
    return Promise.resolve(null);
  }

  workerHealth(): Promise<WorkerHealth> {
    return readWorkerHealth(this.prisma, this.composer ? () => this.composer!.renderQueueStatus() : null);
  }

  async check(userId: string, role: "admin" | "staff", input: AutoPreflightInput): Promise<AutoPreflightResult> {
    const now = new Date();
    const ids = [input.contentAccountId, input.voiceAccountId, input.mediaAccountId, input.renderAccountId].filter(Boolean);
    const [workers, accounts, snapshot] = await Promise.all([
      this.workerHealth(),
      this.prisma.providerAccount.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, provider: true, role: true, status: true, isFake: true, enabled: true, deletedAt: true } }),
      this.findSnapshot(input),
    ]);
    const byId = new Map(accounts.map((row) => [row.id, row]));
    const account = (id: string, expectedRole: string, label: string): AccountFact => {
      const row = byId.get(id);
      if (!row || row.deletedAt) return { ok: false, message: `Chưa chọn tài khoản ${label} hoặc tài khoản đã bị xoá.` };
      if (row.role !== expectedRole) return { ok: false, message: `Tài khoản "${row.name}" không phải tài khoản ${label}.` };
      if (!usable(row)) return { ok: false, message: `Tài khoản ${label} "${row.name}" chưa verify.` };
      if (!row.enabled) return { ok: false, message: `Tài khoản ${label} "${row.name}" đang bị tắt.` };
      return { ok: true, label: `${row.name} (${row.provider})` };
    };

    const renderAccount = account(input.renderAccountId, "render", "render");
    let template: AutoPreflightFacts["template"];
    const renderRow = byId.get(input.renderAccountId);
    if (!snapshot && input.externalTemplateId && renderRow && renderAccount.ok && renderRow.provider !== "lyonix") {
      // A provider template never pinned yet: the account and PUBLIC_BASE_URL are checked now; its slots when it is pinned at submit.
      const engine = renderRow.provider === "orshot" ? "orshot" : "creatomate";
      template = { ok: true, name: input.externalTemplateId, engine, providerRender: "always", videoSlots: 1, imageSlots: 0, orshotPages: null };
    } else if (!snapshot) template = { ok: false, message: "Chưa chọn template hoặc template không còn." };
    else {
      const renderable = this.templates ? await this.templates.checkRenderable(snapshot.id, input.renderAccountId, { checkEngine: true }) : { ok: true as const };
      if (!renderable.ok) template = { ok: false, message: renderable.message };
      else {
        const slots = (Array.isArray(snapshot.modifications) ? snapshot.modifications : []) as Array<{ key?: unknown; kind?: unknown }>;
        const typed = slots.map((slot) => ({ key: String(slot.key ?? ""), kind: String(slot.kind ?? "") }));
        const engine = (snapshot.engine === "lyonix" || snapshot.engine === "orshot" ? snapshot.engine : "creatomate") as "lyonix" | "creatomate" | "orshot";
        const fallbacks = Array.isArray(snapshot.fallbackSnapshotIds) ? snapshot.fallbackSnapshotIds.length : 0;
        template = {
          ok: true,
          name: snapshot.name,
          engine,
          providerRender: engine !== "lyonix" ? "always" : fallbacks > 0 ? "fallback" : "never",
          videoSlots: typed.filter((slot) => slot.kind === "video").length,
          imageSlots: typed.filter((slot) => slot.kind === "image").length,
          orshotPages: engine === "orshot" ? orshotPageCount(typed) : null,
        };
      }
    }
    const publicBaseUrl = template.ok && template.providerRender !== "never" ? await checkPublicBaseUrl() : null;
    const voice = account(input.voiceAccountId, "tts", "giọng đọc");
    return evaluateAutoPreflight({
      workers,
      renderAccount,
      template,
      publicBaseUrl,
      requestedSceneCount: typeof input.sceneCount === "number" && input.sceneCount > 0 ? input.sceneCount : null,
      content: await this.contentAvailability(userId, role, input.contentAccountId, now),
      voice: voice.ok && !input.voiceId.trim() ? { ok: false, message: "Chưa chọn giọng đọc." } : voice,
      media: account(input.mediaAccountId, "visual", "media"),
      now,
    });
  }

  /**
   * Is there a content model that can write the script NOW? The chosen account first, then the other verified content accounts the
   * caller may use (the script step rotates to them). An account in cooldown, or whose every script-capable model is benched,
   * does not count; the earliest moment one becomes usable again is reported.
   */
  async contentAvailability(userId: string, role: "admin" | "staff", preferredAccountId: string, now = new Date()): Promise<AutoPreflightFacts["content"]> {
    const rows = await this.prisma.providerAccount.findMany({
      where: {
        role: "content",
        status: "verified",
        deletedAt: null,
        ...(process.env.NODE_ENV === "test" ? {} : { isFake: false }),
        ...(role === "admin" ? {} : { OR: [{ scope: "organization" }, { scope: "personal", ownerUserId: userId }] }),
      },
      select: { id: true, name: true, provider: true, model: true, availableModels: true, preferredModels: true, modelSnapshot: true, cooldownUntil: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (rows.length === 0) return { ok: false, message: "Chưa có tài khoản content (Gemini/OpenAI…) đã verify.", retryAt: null };
    const ordered = [...rows.filter((row) => row.id === preferredAccountId), ...rows.filter((row) => row.id !== preferredAccountId)];
    const cooldowns = await this.prisma.providerModelCooldown.findMany({ where: { providerAccountId: { in: rows.map((row) => row.id) }, cooldownUntil: { gt: now } }, select: { providerAccountId: true, modelId: true, cooldownUntil: true } });
    let earliest: number | null = null;
    const note = (date: Date) => { earliest = earliest === null ? date.getTime() : Math.min(earliest, date.getTime()); };
    for (const row of ordered) {
      if (!isLiveContentKind(row.provider)) continue;
      if (row.cooldownUntil && row.cooldownUntil > now) {
        note(row.cooldownUntil);
        continue;
      }
      const snapshot = Array.isArray(row.modelSnapshot) ? row.modelSnapshot as Array<{ modelId?: string; status?: string }> : [];
      const unusable = new Set(snapshot.filter((entry) => entry.status === "retired" || entry.status === "unsupported").map((entry) => entry.modelId));
      const ranked = rankContentModels(row.provider, row.availableModels ?? []).filter((modelId) => !unusable.has(modelId));
      const models = [...new Set([...(row.preferredModels ?? []).filter((id) => ranked.includes(id)), ...(ranked.includes(row.model) ? [row.model] : []), ...ranked])];
      const free = models.filter((modelId) => {
        const benched = cooldowns.find((entry) => entry.providerAccountId === row.id && entry.modelId === modelId);
        if (benched) note(benched.cooldownUntil);
        return !benched;
      });
      if (free.length > 0) return { ok: true, models: free };
    }
    const retryAt = earliest === null ? null : new Date(earliest).toISOString();
    return { ok: false, message: "Mọi model viết kịch bản của các tài khoản content đang bị giới hạn quota / cooldown.", retryAt };
  }
}
