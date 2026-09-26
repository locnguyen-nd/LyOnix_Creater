import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import {
  SCRIPT_DRAFT_SCHEMA_VERSION,
  SCRIPT_DRAFT_V1_JSON_SCHEMA,
  SCRIPT_PROMPT_TEMPLATE_VERSION,
  buildScriptPromptPackage,
  captionPlanFromScript,
  generateFakeScriptDraft,
  generateLiveStructured,
  isContentLanguage,
  isLiveContentKind,
  ProviderError,
  resolveContentModel,
  validateScriptDraftV1,
  type CaptionPlanV1,
  type ContentLanguage,
  type JsonSchema,
  type LiveContentKind,
} from "@lyonix/providers";
import { canAccessChannel, canDeleteJob, canReviewJob } from "./grant-access.js";
import { GrantsService } from "./grants.service.js";
import { PrismaService } from "./prisma.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { emptyScript, parseScriptDraft, type ScriptDraft } from "./script-draft.js";
import { handoffFingerprint, writeHandoffWorkspace } from "./handoff-workspace.js";

export type JobEvent = { id: string; at: string; kind: string; message: string };

export type JobRecord = {
  id: string;
  code: string;
  mode: "topic" | "long_video";
  topic: string;
  locale: string;
  status: string;
  currentStep: string;
  channelId: string;
  promptSpec: string;
  contentProviderAccountId: string;
  model: string;
  promptTemplateVersion: string;
  schemaVersion: string;
  providerConfigVersion: number;
  createdByUserId: string;
  updatedAt: string;
  events: JobEvent[];
  lastNotice: string | null;
  captionPlan: CaptionPlanV1 | null;
  handoff: { status: string; relativePath: string; fingerprint: string; sceneCount: number } | null;
  script: ScriptDraft;
};

type StoredMeta = {
  code: string;
  mode: "topic" | "long_video";
  channelId: string;
  promptSpec: string;
  contentProviderAccountId: string;
  model: string;
  currentStep: string;
  promptTemplateVersion: string;
  schemaVersion: string;
  providerConfigVersion: number;
  events: JobEvent[];
};

type StoredContent = {
  meta: StoredMeta;
  script: ScriptDraft;
  captionPlan?: CaptionPlanV1;
};

const stepForStatus = (status: string): StoredMeta["currentStep"] => {
  if (status === "handoff_workspace_ready") return "done";
  if (status === "producing") return "produce";
  if (status === "awaiting_staff_ack") return "review";
  return "script";
};

export const noticeAfterApprove = (version: number) => `Đã duyệt kịch bản phiên bản v${version}. Đang tách cảnh và phụ đề.`;
export const noticeAfterHandoff = (scenes: number, relativePath: string) =>
  `Đã tách ${scenes} cảnh, ghi caption/asset và workspace handoff (${relativePath}).`;
export const noticeAfterGenerate = (provider: string, model: string, version: number, requestId?: string | null) =>
  `Đã gọi ${provider} (${model}) và nhận kịch bản v${version}${requestId ? ` · req ${requestId}` : ""}.`;
export const SWITCHABLE_PROVIDER_CODES = ["PROVIDER_RATE_LIMITED", "PROVIDER_QUOTA_EXHAUSTED", "PROVIDER_AUTH_INVALID"] as const;
export const isSwitchableProviderError = (code: string) =>
  (SWITCHABLE_PROVIDER_CODES as readonly string[]).includes(code);

export const noticeGenerateFailed = (provider: string, model: string, detail: string) =>
  `Generate thất bại — chưa gọi xong ${provider}/${model}: ${detail}`;
export const noticeSuggestSwitch = (provider: string, model: string, detail: string) =>
  `${noticeGenerateFailed(provider, model, detail)} Đổi tài khoản content khác rồi Generate lại.`;
export const noticeAfterSwitchAccount = (provider: string, model: string) =>
  `Đã đổi sang ${provider} (${model}). Generate lại trên tài khoản này.`;
export const splitTopicSource = (raw: string) => {
  const text = raw.trim();
  if (text.length <= 220) return { topic: text, source: "" };
  const topic = text.slice(0, 80).replace(/\s+\S*$/, "").trim() || text.slice(0, 80);
  return { topic, source: text };
};

const contentAccountReady = (account: { role: string; provider: string; isFake: boolean; status: string }) =>
  account.role === "content" && (account.isFake || (isLiveContentKind(account.provider) && account.status === "verified"));

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  async list(userId: string, role: "admin" | "staff") {
    const grants = await this.grants.forUser(userId, role);
    const rows = await this.prisma.productionRequest.findMany({
      include: {
        scripts: { orderBy: { version: "desc" }, take: 1, include: { subtitles: true, assets: true } },
        handoffs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((row) => this.toJob(row)).filter((job) => canReviewJob(role, grants, { ownerUserId: job.createdByUserId, channelId: job.channelId }, userId));
  }

  async get(id: string, userId: string, role: "admin" | "staff") {
    const grants = await this.grants.forUser(userId, role);
    const row = await this.prisma.productionRequest.findUnique({
      where: { id },
      include: {
        scripts: { orderBy: { version: "desc" }, take: 1, include: { subtitles: true, assets: true } },
        handoffs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!row) return null;
    const job = this.toJob(row);
    if (!canReviewJob(role, grants, { ownerUserId: job.createdByUserId, channelId: job.channelId }, userId)) return null;
    return job;
  }

  async create(input: {
    userId: string;
    topic: string;
    locale: string;
    mode: "topic" | "long_video";
    channelId: string;
    promptSpec: string;
    contentProviderAccountId: string;
    existingScript?: string;
  }) {
    const { topic, source } = splitTopicSource(input.topic);
    if (!topic) return "invalid" as const;
    const actor = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!actor) return "invalid" as const;
    const grants = await this.grants.forUser(input.userId, actor.role);
    if (!canAccessChannel(actor.role, grants, input.channelId)) return "forbidden" as const;
    const account = await this.prisma.providerAccount.findUnique({ where: { id: input.contentProviderAccountId } });
    if (!account || !contentAccountReady(account)) return "provider" as const;
    const count = await this.prisma.productionRequest.count();
    const locale = isContentLanguage(input.locale) ? input.locale : "vi";
    const sourceNotes = [source, input.promptSpec.trim(), input.existingScript?.trim()].filter(Boolean).join("\n\n");
    const seed = input.existingScript?.trim() && input.existingScript.trim().length <= 4000
      ? parseScriptDraft({
        body: input.existingScript,
        hook: topic,
        title: topic,
        cta: "",
        caption: topic,
        scenes: [{ sceneId: "s01", narration: input.existingScript, screenText: topic, visualBrief: "", estimatedDurationMs: 5000 }],
      }, 1, null, locale)
      : emptyScript(topic, locale);
    const script = seed ?? emptyScript(topic, locale);
    const meta = this.baseMeta({
      code: `JOB-${1001 + count}`,
      mode: input.mode,
      channelId: input.channelId,
      promptSpec: sourceNotes,
      contentProviderAccountId: account.id,
      model: account.model,
      currentStep: "script",
      promptTemplateVersion: SCRIPT_PROMPT_TEMPLATE_VERSION,
      schemaVersion: SCRIPT_DRAFT_SCHEMA_VERSION,
      providerConfigVersion: account.configVersion,
      events: [{ id: randomUUID(), at: new Date().toISOString(), kind: "job_created", message: "Đã tạo việc. Đang ở bước kịch bản." }],
    });
    const row = await this.prisma.productionRequest.create({
      data: {
        ownerUserId: input.userId,
        topic,
        locale,
        status: "scripting",
        inputFingerprint: createHash("sha256").update(`${input.userId}:${randomUUID()}:${topic}`).digest("hex"),
        scripts: { create: { version: 1, content: { meta, script } } },
      },
      include: {
        scripts: { orderBy: { version: "desc" }, take: 1, include: { subtitles: true, assets: true } },
        handoffs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    return this.toJob(row);
  }

  async saveScript(id: string, userId: string, role: "admin" | "staff", script: ScriptDraft) {
    const job = await this.get(id, userId, role);
    if (!job) return null;
    const next = { ...script, version: job.script.version + 1, approvedVersion: null };
    await this.writeScript(id, job, next, "scripting", {
      kind: "script_saved",
      message: `Đã lưu bản nháp v${next.version}. Duyệt lại sau khi sửa.`,
    });
    return this.get(id, userId, role);
  }

  private async liveAccount(id: string) {
    const row = await this.prisma.providerAccount.findUnique({ where: { id } });
    if (!row || !contentAccountReady(row)) return null;
    if (!isLiveContentKind(row.provider)) return row;
    const model = resolveContentModel(row.provider, row.model);
    if (model === row.model) return row;
    return this.prisma.providerAccount.update({ where: { id: row.id }, data: { model } });
  }

  async generate(id: string, userId: string, role: "admin" | "staff", direction: string) {
    const job = await this.get(id, userId, role);
    if (!job) return null;
    const account = await this.liveAccount(job.contentProviderAccountId);
    if (!account) return "provider" as const;
    const language = isContentLanguage(job.locale) ? job.locale : "vi";
    const pkg = buildScriptPromptPackage({
      topic: job.topic,
      language,
      direction,
      promptSpec: job.promptSpec,
      existing: job.script,
    });
    const nextVersion = job.script.version + 1;
    const callInput = { topic: job.topic, language, direction: pkg.direction, promptSpec: pkg.promptSpec, version: nextVersion };
    this.logger.log(`content_generate start job=${id} provider=${account.provider} model=${account.model} promptChars=${pkg.text.length}`);
    try {
      const first = await this.callContent(account, pkg.text, callInput, SCRIPT_DRAFT_V1_JSON_SCHEMA);
      const parsed = this.acceptDraft(first.output, nextVersion, language)
        ?? this.acceptDraft((await this.callContent(account, pkg.repairText, { ...callInput, version: nextVersion + 17 }, SCRIPT_DRAFT_V1_JSON_SCHEMA)).output, nextVersion, language);
      if (!parsed) {
        await this.appendEvent(id, job, {
          kind: "generate_failed",
          message: noticeGenerateFailed(account.provider, account.model, "JSON không khớp ScriptDraftV1"),
        });
        this.logger.warn(`content_generate schema_fail job=${id} provider=${account.provider} model=${account.model}`);
        return "schema" as const;
      }
      this.logger.log(`content_generate ok job=${id} provider=${account.provider} model=${account.model} scenes=${parsed.scenes.length} req=${first.usage.providerRequestId ?? "n/a"}`);
      await this.writeScript(id, job, { ...parsed, approvedVersion: null }, "awaiting_staff_ack", {
        kind: "script_generated",
        message: noticeAfterGenerate(account.provider, account.model, nextVersion, first.usage.providerRequestId),
      }, { promptTemplateVersion: pkg.promptTemplateVersion, providerConfigVersion: account.configVersion });
      return this.get(id, userId, role);
    } catch (error) {
      const detail = error instanceof ProviderError ? `${error.code}: ${error.message}` : "network/timeout";
      this.logger.warn(`content_generate fail job=${id} provider=${account.provider} model=${account.model} ${detail}`);
      const switchable = error instanceof ProviderError && isSwitchableProviderError(error.code);
      await this.appendEvent(id, job, {
        kind: switchable ? "blocked_provider" : "generate_failed",
        message: switchable
          ? noticeSuggestSwitch(account.provider, account.model, detail)
          : noticeGenerateFailed(account.provider, account.model, detail),
      }).catch(() => undefined);
      if (error instanceof ProviderError) return error.code;
      return "provider" as const;
    }
  }

  async switchContentAccount(id: string, userId: string, role: "admin" | "staff", contentProviderAccountId: string) {
    const job = await this.get(id, userId, role);
    if (!job) return null;
    if (contentProviderAccountId === job.contentProviderAccountId) return "same" as const;
    const account = await this.prisma.providerAccount.findUnique({ where: { id: contentProviderAccountId } });
    if (!account || !contentAccountReady(account)) return "provider" as const;
    const latest = await this.prisma.scriptVersion.findFirst({ where: { productionRequestId: id }, orderBy: { version: "desc" } });
    if (!latest) return null;
    const payload = (latest.content ?? {}) as Partial<StoredContent>;
    const meta = this.mergeMeta(job, payload.meta, {
      contentProviderAccountId: account.id,
      model: account.model,
      providerConfigVersion: account.configVersion,
      currentStep: "script",
      events: [{ id: randomUUID(), at: new Date().toISOString(), kind: "switch_account", message: noticeAfterSwitchAccount(account.provider, account.model) }],
    });
    await this.prisma.$transaction([
      this.prisma.productionRequest.update({ where: { id }, data: { status: "scripting" } }),
      this.prisma.scriptVersion.update({ where: { id: latest.id }, data: { content: { ...payload, meta } } }),
    ]);
    return this.get(id, userId, role);
  }

  async approve(id: string, userId: string, role: "admin" | "staff") {
    const job = await this.get(id, userId, role);
    if (!job) return null;
    if (job.status === "handoff_workspace_ready") return job;
    const latest = await this.prisma.scriptVersion.findFirst({
      where: { productionRequestId: id },
      orderBy: { version: "desc" },
      include: { subtitles: true, assets: true },
    });
    if (!latest) return null;
    // Approve just needs to split the already-approved script into scenes/captions - a pure
    // transform of data the script step already produced (job.script.scenes), not a new
    // authoring task. `captionPlanFromScript` does this deterministically with no model call,
    // so approving with nothing further to add never touches the content provider (previously
    // every approve re-called it here, which is what burned through account quota/rate limits
    // - see pipeline/STATUS.md 25/09-26/09 "Duyệt kịch bản" incidents). The provider account is
    // only read (DB row, no network) for provider/model labels on the handoff manifest.
    const account = await this.prisma.providerAccount.findUnique({ where: { id: job.contentProviderAccountId } });
    const plan: CaptionPlanV1 = captionPlanFromScript(job.script);
    const payload = (latest.content ?? {}) as Partial<StoredContent>;
    const produced = await writeHandoffWorkspace({
      productionRequestId: id,
      scriptVersionId: latest.id,
      scriptVersion: latest.version,
      locale: job.locale,
      topic: job.topic,
      provider: account?.provider ?? "unknown",
      model: account?.model ?? job.model,
      promptTemplateVersion: job.promptTemplateVersion,
      schemaVersion: job.schemaVersion,
      providerConfigVersion: account?.configVersion ?? job.providerConfigVersion,
      assetSource: account?.isFake ? "fixture" : "generated",
      script: job.script,
      captionPlan: plan,
    });
    const fingerprint = handoffFingerprint({
      productionRequestId: id,
      scriptVersion: latest.version,
      promptTemplateVersion: job.promptTemplateVersion,
      schemaVersion: job.schemaVersion,
      providerConfigVersion: account?.configVersion ?? job.providerConfigVersion,
    });
    const ready = produced.manifest.status === "ready";
    const meta = this.mergeMeta(job, payload.meta, {
      currentStep: ready ? "done" : "produce",
      events: [{
        id: randomUUID(),
        at: new Date().toISOString(),
        kind: ready ? "handoff_ready" : "script_approved",
        message: ready ? noticeAfterHandoff(plan.scenes.length, produced.relativePath) : noticeAfterApprove(latest.version),
      }],
    });
    const script = { ...job.script, approvedVersion: latest.version };
    const cues = plan.scenes.flatMap((scene) => scene.segments.map((segment) => segment.text));
    await this.prisma.$transaction([
      this.prisma.productionRequest.update({ where: { id }, data: { status: ready ? "handoff_workspace_ready" : "producing" } }),
      this.prisma.scriptVersion.update({
        where: { id: latest.id },
        data: { approvedAt: new Date(), content: { meta, script, captionPlan: plan } },
      }),
      this.prisma.subtitleCue.deleteMany({ where: { scriptVersionId: latest.id } }),
      this.prisma.workflowAsset.deleteMany({ where: { scriptVersionId: latest.id } }),
    ]);
    if (cues.length) {
      await this.prisma.subtitleCue.createMany({
        data: cues.map((text, cueIndex) => ({ scriptVersionId: latest.id, cueIndex, text })),
      });
    }
    await this.prisma.workflowAsset.createMany({
      data: plan.scenes.map((scene, sceneIndex) => {
        const file = produced.files.find((item) => item.relativePath === (scene.visualAsset.startsWith("visuals/") ? scene.visualAsset : `visuals/${scene.sceneId}.txt`));
        return {
          scriptVersionId: latest.id,
          sceneIndex,
          relativePath: file?.relativePath ?? `visuals/${scene.sceneId}.txt`,
          mediaType: "text/plain",
          sha256: file?.sha256 ?? "",
          source: account?.isFake ? "fixture" : "generated",
        };
      }),
    });
    const existingHandoff = await this.prisma.handoffWorkspace.findUnique({ where: { fingerprint } });
    if (existingHandoff) {
      await this.prisma.handoffWorkspace.update({
        where: { id: existingHandoff.id },
        data: { status: produced.manifest.status, relativePath: produced.relativePath, manifest: produced.manifest as object, timelineVersionId: `script-v${latest.version}` },
      });
    } else {
      await this.prisma.handoffWorkspace.create({
        data: {
          productionRequestId: id,
          timelineVersionId: `script-v${latest.version}`,
          relativePath: produced.relativePath,
          fingerprint,
          status: produced.manifest.status,
          manifest: produced.manifest as object,
        },
      });
    }
    return this.get(id, userId, role);
  }

  async remove(id: string, userId: string, role: "admin" | "staff") {
    const job = await this.get(id, userId, role);
    if (!job) return null;
    if (!canDeleteJob(role, { ownerUserId: job.createdByUserId }, userId)) return "forbidden" as const;
    await this.prisma.productionRequest.delete({ where: { id } });
    this.logger.log(`job_deleted job=${id} by=${userId}`);
    return true as const;
  }

  private acceptDraft(output: unknown, version: number, language: ContentLanguage) {
    const parsed = parseScriptDraft(output, version, null, language);
    if (!parsed) return null;
    return validateScriptDraftV1(parsed).ok ? parsed : null;
  }

  private async callContent(
    account: { provider: string; model: string; encryptedSecret: string; isFake: boolean },
    prompt: string,
    fake: { topic: string; language: ContentLanguage; direction: string; promptSpec: string; version: number },
    schema: JsonSchema,
    captionSource?: ScriptDraft,
  ) {
    if (account.isFake || account.provider === "fake") {
      return {
        output: captionSource ? captionPlanFromScript(captionSource) : generateFakeScriptDraft(fake),
        usage: { inputTokens: null, outputTokens: null, providerRequestId: "fake", cost: { amount: null, currency: null, unit: "tokens" } },
      };
    }
    if (!isLiveContentKind(account.provider)) throw new ProviderError("PROVIDER_CAPABILITY_UNAVAILABLE", "Provider role is not registered", false);
    return generateLiveStructured<unknown>(
      account.provider as LiveContentKind,
      decryptSecret(account.encryptedSecret),
      account.model,
      prompt,
      schema,
    );
  }

  private async writeScript(
    id: string,
    job: JobRecord,
    script: ScriptDraft,
    status: "scripting" | "awaiting_staff_ack",
    event: { kind: string; message: string },
    pin?: { promptTemplateVersion?: string; providerConfigVersion?: number },
  ) {
    const latest = await this.prisma.scriptVersion.findFirst({ where: { productionRequestId: id }, orderBy: { version: "desc" } });
    const payload = (latest?.content ?? {}) as Partial<StoredContent>;
    const version = (latest?.version ?? 0) + 1;
    const meta = this.mergeMeta(job, payload.meta, {
      currentStep: stepForStatus(status),
      ...(pin?.promptTemplateVersion ? { promptTemplateVersion: pin.promptTemplateVersion } : {}),
      ...(pin?.providerConfigVersion !== undefined ? { providerConfigVersion: pin.providerConfigVersion } : {}),
      events: [{ id: randomUUID(), at: new Date().toISOString(), kind: event.kind, message: event.message }],
    });
    await this.prisma.$transaction([
      this.prisma.productionRequest.update({ where: { id }, data: { status } }),
      this.prisma.scriptVersion.create({
        data: {
          productionRequestId: id,
          version,
          approvedAt: null,
          content: { meta, script: { ...script, version, approvedVersion: null } },
        },
      }),
    ]);
  }

  private baseMeta(meta: StoredMeta): StoredMeta {
    return meta;
  }

  private async appendEvent(id: string, job: JobRecord, event: { kind: string; message: string }) {
    const latest = await this.prisma.scriptVersion.findFirst({ where: { productionRequestId: id }, orderBy: { version: "desc" } });
    if (!latest) return;
    const payload = (latest.content ?? {}) as Partial<StoredContent>;
    const meta = this.mergeMeta(job, payload.meta, {
      events: [{ id: randomUUID(), at: new Date().toISOString(), kind: event.kind, message: event.message }],
    });
    await this.prisma.scriptVersion.update({
      where: { id: latest.id },
      data: { content: { ...payload, meta } },
    });
  }

  private mergeMeta(job: JobRecord, incoming: Partial<StoredMeta> | undefined, patch: {
    currentStep?: string;
    promptTemplateVersion?: string;
    providerConfigVersion?: number;
    contentProviderAccountId?: string;
    model?: string;
    events?: JobEvent[];
  }): StoredMeta {
    const prevEvents = incoming?.events ?? job.events ?? [];
    return {
      code: incoming?.code ?? job.code,
      mode: incoming?.mode ?? job.mode,
      channelId: incoming?.channelId ?? job.channelId,
      promptSpec: incoming?.promptSpec ?? job.promptSpec,
      contentProviderAccountId: patch.contentProviderAccountId ?? incoming?.contentProviderAccountId ?? job.contentProviderAccountId,
      model: patch.model ?? incoming?.model ?? job.model,
      currentStep: patch.currentStep ?? incoming?.currentStep ?? job.currentStep,
      promptTemplateVersion: patch.promptTemplateVersion ?? incoming?.promptTemplateVersion ?? job.promptTemplateVersion ?? SCRIPT_PROMPT_TEMPLATE_VERSION,
      schemaVersion: incoming?.schemaVersion ?? job.schemaVersion ?? SCRIPT_DRAFT_SCHEMA_VERSION,
      providerConfigVersion: patch.providerConfigVersion ?? incoming?.providerConfigVersion ?? job.providerConfigVersion ?? 1,
      events: [...(patch.events ?? []), ...prevEvents].slice(0, 40),
    };
  }

  private toJob(row: {
    id: string;
    ownerUserId: string;
    topic: string;
    locale: string;
    status: string;
    updatedAt: Date;
    scripts: Array<{ version: number; approvedAt: Date | null; content: unknown }>;
    handoffs?: Array<{ status: string; relativePath: string; fingerprint: string; manifest: unknown }>;
  }): JobRecord {
    const latest = row.scripts[0];
    const payload = (latest?.content ?? {}) as Partial<StoredContent>;
    const meta = payload.meta;
    const script = parseScriptDraft(payload.script ?? payload, latest?.version ?? 1, latest?.approvedAt ? latest.version : null, row.locale) ?? emptyScript(row.topic, row.locale);
    const events = meta?.events ?? [];
    const captionPlan = payload.captionPlan ?? null;
    const handoffRow = row.handoffs?.[0];
    return {
      id: row.id,
      code: meta?.code ?? `JOB-${row.id.slice(0, 8)}`,
      mode: meta?.mode === "long_video" ? "long_video" : "topic",
      topic: row.topic,
      locale: row.locale,
      status: row.status,
      currentStep: meta?.currentStep ?? stepForStatus(row.status),
      channelId: meta?.channelId ?? "",
      promptSpec: meta?.promptSpec ?? "",
      contentProviderAccountId: meta?.contentProviderAccountId ?? "",
      model: meta?.model ?? "",
      promptTemplateVersion: meta?.promptTemplateVersion ?? SCRIPT_PROMPT_TEMPLATE_VERSION,
      schemaVersion: meta?.schemaVersion ?? SCRIPT_DRAFT_SCHEMA_VERSION,
      providerConfigVersion: meta?.providerConfigVersion ?? 1,
      createdByUserId: row.ownerUserId,
      updatedAt: row.updatedAt.toISOString(),
      events,
      lastNotice: events[0]?.message ?? null,
      captionPlan,
      handoff: handoffRow ? {
        status: handoffRow.status,
        relativePath: handoffRow.relativePath,
        fingerprint: handoffRow.fingerprint,
        sceneCount: captionPlan?.scenes.length ?? script.scenes.length,
      } : null,
      script,
    };
  }
}
