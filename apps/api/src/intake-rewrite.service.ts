/**
 * VE2E-96: the URL intake's rewrite - analysed source text -> an ORIGINAL short-video script, with the user's content account (the
 * form's, else their first usable one; same model ranking / failover / cooldowns as script generation). The result is checked against
 * the source (`textOverlapRatio`): a draft that stays too close is rewritten once more and the closer one is never preferred.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { defaultCharsPerSecond, textOverlapRatio } from "@lyonix/domain";
import { isLiveContentKind, rankContentModels, rewriteSourceAsScript, type SourceRewriteInput } from "@lyonix/providers";
import type { UiLocale, UrlIntakeRewrite, UrlIntakeRewriteRequest } from "@lyonix/contracts";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { decryptSecret } from "./secret-crypto.js";
import { callContentWithModelFailover, rotatesToNextAccount } from "./content-model-failover.js";

/** Above this share of copied runs a draft counts as too close to its source. */
export const REWRITE_MAX_OVERLAP = 0.2;
export const REWRITE_DEFAULT_SECONDS = 55;
/** The script asks for at most this many characters per source character. */
export const REWRITE_MAX_EXPANSION = 1.5;

export const INTAKE_REWRITE_OPTIONS = "INTAKE_REWRITE_OPTIONS";
export type IntakeRewriteOptions = { rewrite?: typeof rewriteSourceAsScript };

type Accounts = Pick<ProviderAccountsService, "contentGenerationCandidates" | "acquireContentRequestSlot" | "releaseContentRequestSlot" | "cooldownContentAccount" | "markModelUnusable" | "markModelLimited" | "getModelAvailability">;

@Injectable()
export class IntakeRewriteService {
  private readonly rewriteFn: typeof rewriteSourceAsScript;

  constructor(@Inject(ProviderAccountsService) private readonly accounts: Accounts, @Optional() @Inject(INTAKE_REWRITE_OPTIONS) options?: IntakeRewriteOptions) {
    this.rewriteFn = options?.rewrite ?? rewriteSourceAsScript;
  }

  async rewrite(userId: string, role: "admin" | "staff", request: UrlIntakeRewriteRequest): Promise<UrlIntakeRewrite> {
    const text = request.source.cleanedText.trim();
    if (!text) return { status: "failed", code: "VALIDATION_FAILED", message: "Nguồn không có nội dung để viết lại" };
    const language: UiLocale = request.language ?? "vi";
    const requested = request.durationSec && Number.isFinite(request.durationSec) ? Math.min(180, Math.max(10, Math.round(request.durationSec))) : REWRITE_DEFAULT_SECONDS;
    // a thin source makes a short script: the target never asks for more than ~1.5x the source (a model asked for more invents)
    const seconds = Math.max(10, Math.min(requested, Math.round(([...text].length * REWRITE_MAX_EXPANSION) / defaultCharsPerSecond(language))));
    const input: SourceRewriteInput = {
      sourceType: request.source.sourceType,
      sourceName: request.source.sourceName,
      title: request.source.title,
      text,
      targetLanguage: language,
      targetSeconds: seconds,
      charsPerSecond: defaultCharsPerSecond(language),
    };

    const candidates = await this.accounts.contentGenerationCandidates(userId, role, request.contentAccountId);
    if (request.contentAccountId && !candidates.some((account) => account.id === request.contentAccountId)) {
      return { status: "failed", code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản content không tồn tại hoặc bạn không được phép dùng" };
    }
    let lastError: { code: string; message: string } | null = null;
    let usable = 0;
    for (const account of candidates) {
      if (account.role !== "content" || !isLiveContentKind(account.provider)) continue;
      if (account.isFake ? process.env.NODE_ENV !== "test" : account.status !== "verified") continue;
      const snapshots = Array.isArray(account.modelSnapshot) ? (account.modelSnapshot as Array<{ modelId: string; status: string }>) : [];
      const unavailable = new Set(snapshots.filter((entry) => entry.status === "retired" || entry.status === "unsupported").map((entry) => entry.modelId));
      const ranked = rankContentModels(account.provider, account.availableModels ?? []).filter((modelId) => !unavailable.has(modelId));
      const models = [...new Set([...(account.preferredModels ?? []).filter((modelId) => ranked.includes(modelId)), ...(ranked.includes(account.model) ? [account.model] : []), ...ranked])];
      if (models.length === 0) continue;
      usable += 1;
      const apiKey = decryptSecret(account.encryptedSecret);
      const provider = account.provider;
      const attempt = (extra: Partial<SourceRewriteInput>) => callContentWithModelFailover(this.accounts, account.id, models, (modelId) => this.rewriteFn(provider, apiKey, modelId, { ...input, ...extra }));

      const first = await attempt({});
      if (!first.ok) {
        if (first.thrown !== undefined) return { status: "failed", code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi provider viết lại kịch bản" };
        if (first.error) lastError = { code: first.error.code, message: first.error.message };
        if (first.error && !rotatesToNextAccount(first.error.code)) break;
        continue;
      }
      let best = { draft: first.value, overlap: textOverlapRatio(text, first.value.script) };
      if (best.overlap > REWRITE_MAX_OVERLAP) {
        const second = await attempt({ tooCloseFeedback: true });
        if (second.ok) {
          const overlap = textOverlapRatio(text, second.value.script);
          if (overlap < best.overlap) best = { draft: second.value, overlap };
        }
      }
      return {
        status: "done",
        script: best.draft.script,
        hook: best.draft.hook,
        language: best.draft.language ?? language,
        characterCount: [...best.draft.script].length,
        providerUsed: `${provider}/${best.draft.modelId}`,
        overlapRatio: Math.round(best.overlap * 1000) / 1000,
        overlapHigh: best.overlap > REWRITE_MAX_OVERLAP,
      };
    }
    if (usable === 0 && !lastError) return { status: "skipped", reason: "no_content_account" };
    return { status: "failed", code: lastError?.code ?? "PROVIDER_CAPABILITY_UNAVAILABLE", message: lastError?.message ?? "Không có model content khả dụng để viết lại kịch bản" };
  }
}
