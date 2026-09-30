import { Inject, Injectable } from "@nestjs/common";
import {
  ProviderError,
  extractSegmentKeywords,
  generateScriptDraftV2,
  isContentLanguageV2,
  isLiveContentKind,
  isScriptSourceKind,
  rankContentModels,
  CONTENT_MODEL_RANKING_VERSION,
} from "@lyonix/providers";
import type { ErrorCode, ScriptDraftV2GenerationResponse } from "@lyonix/contracts";
import { SourcesService } from "./sources.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { decryptSecret } from "./secret-crypto.js";

export type GenerateScriptDraftInput = {
  providerAccountId?: string;
  language?: string;
  direction?: string;
  /** VE2E-38/40: target background segment range for the draft's visualPlan (Auto passes the run's resolved intake setting; absent = default rule). Internal only, not an HTTP body field. */
  backgroundSegmentRange?: { min: number; max: number } | null;
};

export type GenerateScriptDraftOutcome =
  | { ok: true; response: ScriptDraftV2GenerationResponse }
  | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

/** VE2E-50: outcome of the dedicated keyword-extraction call. */
export type SegmentKeywordsOutcome =
  | {
      ok: true;
      keywords: Record<string, { ja: string; en: string }>;
      rejectedSegmentIds: string[];
      usage: { inputTokens: number | null; outputTokens: number | null; costAmount: string | null; costCurrency: string | null; providerRequestId: string | null };
      modelId: string;
      provider: string;
      promptTemplateVersion: string;
    }
  | { ok: false; code: ErrorCode; message: string };

const providerErrorMessage: Record<string, string> = {
  PROVIDER_AUTH_INVALID: "Khóa API bị từ chối. Verify lại tài khoản content provider.",
  PROVIDER_SCHEMA_INVALID: "Model không trả ScriptDraftV2 hợp lệ sau khi thử sửa lại.",
  PROVIDER_RATE_LIMITED: "Provider giới hạn tốc độ, thử lại sau.",
  PROVIDER_QUOTA_EXHAUSTED: "Tài khoản content hết credit/quota.",
  PROVIDER_TIMEOUT: "Generate hết thời gian chờ.",
  PROVIDER_CAPABILITY_UNAVAILABLE: "Model không khả dụng cho tài khoản này.",
  PROVIDER_CONTENT_REFUSED: "Provider từ chối nội dung.",
};

@Injectable()
export class ScriptGenerationService {
  constructor(
    @Inject(SourcesService) private readonly sources: SourcesService,
    @Inject(ProviderAccountsService) private readonly providerAccounts: ProviderAccountsService,
  ) {}

  async generate(sourceId: string, userId: string, role: "admin" | "staff", input: GenerateScriptDraftInput): Promise<null | "forbidden" | GenerateScriptDraftOutcome> {
    const source = await this.sources.getRowForGeneration(sourceId, userId, role);
    if (!source) return null;
    if (source === "forbidden") return "forbidden" as const;
    if (!isScriptSourceKind(source.type)) return { ok: false, code: "VALIDATION_FAILED", message: "Loại nguồn không hỗ trợ" };
    const sourceText = source.extractedText ?? source.rawText;
    if (!sourceText) {
      return {
        ok: false,
        code: "INVALID_STATE",
        message: source.type === "article_url"
          ? "Nguồn article_url chưa được trích xuất. Gọi POST /sources/:id/extract trước."
          : "Nguồn chưa có nội dung trích xuất (extractedText)",
      };
    }
    const language = input.language && isContentLanguageV2(input.language) ? input.language : "vi";
    const accounts = await this.providerAccounts.contentGenerationCandidates(userId, role, input.providerAccountId);
    if (input.providerAccountId && !accounts.some((account) => account.id === input.providerAccountId)) {
      return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản content không tồn tại hoặc caller không được phép sử dụng", status: 404 };
    }
    if (accounts.length === 0) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Chưa có tài khoản content đã verify và được phép sử dụng", status: 503 };

    let lastError: ProviderError | null = null;
    for (const account of accounts) {
      if (account.role !== "content" || !isLiveContentKind(account.provider)) continue;
      const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
      if (!usable) continue;
      const snapshots = Array.isArray(account.modelSnapshot) ? account.modelSnapshot as Array<{ modelId: string; status: string }> : [];
      const unavailable = new Set(snapshots.filter((entry) => entry.status === "retired" || entry.status === "unsupported").map((entry) => entry.modelId));
      const ranked = rankContentModels(account.provider, account.availableModels ?? []).filter((modelId) => !unavailable.has(modelId));
      const models = [
        ...(ranked.includes(account.model) ? [account.model] : []),
        ...ranked.filter((modelId) => modelId !== account.model),
      ];
      if (models.length === 0) continue;

      const acquired = await this.providerAccounts.acquireContentRequestSlot(account.id);
      if (!acquired) {
        lastError = new ProviderError("PROVIDER_RATE_LIMITED", "Tài khoản đang trong cooldown hoặc đã đạt concurrency tối đa", true, 1_000);
        continue;
      }
      try {
        const apiKey = decryptSecret(account.encryptedSecret);
        for (const modelId of models) {
          try {
            const result = await generateScriptDraftV2(account.provider, apiKey, modelId, {
              sourceType: source.type,
              sourceText,
              originRef: source.originRef,
              language,
              ...(input.direction ? { direction: input.direction } : {}),
              ...(input.backgroundSegmentRange ? { backgroundSegmentRange: input.backgroundSegmentRange } : {}),
            });
            if (result.modelId !== account.model) {
              await this.providerAccounts.repinModel(account.id, result.modelId).catch(() => undefined);
            }
            return { ok: true, response: this.buildResponse(sourceId, account, result, input.providerAccountId ? "preferred_account" : "automatic_preference") };
          } catch (error) {
            if (!(error instanceof ProviderError)) return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi provider; chưa tự gửi lại request mơ hồ", status: 502 };
            lastError = error;
            if (error.code === "PROVIDER_CAPABILITY_UNAVAILABLE") {
              await this.providerAccounts.markModelUnusable(account.id, modelId, error.message).catch(() => undefined);
            }
            if (error.code === "PROVIDER_CAPABILITY_UNAVAILABLE" || error.code === "PROVIDER_SCHEMA_INVALID") continue;
            if (error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED" || error.code === "PROVIDER_AUTH_INVALID") {
              const defaultCooldownMs = error.code === "PROVIDER_QUOTA_EXHAUSTED" ? 15 * 60_000 : error.code === "PROVIDER_AUTH_INVALID" ? 5 * 60_000 : 60_000;
              await this.providerAccounts.cooldownContentAccount(account.id, error.retryAfterMs ?? defaultCooldownMs).catch(() => undefined);
            }
            break;
          }
        }
      } finally {
        await this.providerAccounts.releaseContentRequestSlot(account.id).catch(() => undefined);
      }
      // A quota/auth/429 account is now persisted in cooldown, so this moves only to another
      // verified account visible to this actor; no further model calls are made on the failed key.
      if (lastError && !["PROVIDER_RATE_LIMITED", "PROVIDER_QUOTA_EXHAUSTED", "PROVIDER_AUTH_INVALID"].includes(lastError.code)) break;
    }
    if (!lastError) return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Không có model khả dụng trên các tài khoản content được phép dùng", status: 503 };
    const error = lastError;
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED" || error.code === "PROVIDER_AUTH_INVALID";
    return {
      ok: false,
      code: error.code,
      message: error.code === "PROVIDER_CAPABILITY_UNAVAILABLE"
        ? "Model không còn khả dụng trên các tài khoản content được phép dùng. Cập nhật model trong Cài đặt provider."
        : error.code === "PROVIDER_QUOTA_EXHAUSTED"
          ? "Tài khoản khả dụng đã hết quota; hãy kiểm tra billing hoặc kết nối thêm account content."
          : error.code === "PROVIDER_RATE_LIMITED" && accounts.length > 1
            ? "Các tài khoản content khả dụng đang bị giới hạn tốc độ hoặc cooldown. Hãy thử lại sau."
        : providerErrorMessage[error.code] ?? "Nhà cung cấp từ chối generate",
      status: switchable ? 429 : 502,
      retryable: error.retryable,
    };
  }

  /** VE2E-55: the verified content account the caller may use (same candidate list/order as {@link generate}), or null. */
  async resolveContentAccountId(userId: string, role: "admin" | "staff"): Promise<string | null> {
    const accounts = await this.providerAccounts.contentGenerationCandidates(userId, role);
    const account = accounts.find((candidate) => candidate.role === "content" && isLiveContentKind(candidate.provider) && (candidate.isFake ? process.env.NODE_ENV === "test" : candidate.status === "verified"));
    return account?.id ?? null;
  }

  /**
   * VE2E-50: ONE cheap content call that returns ja+en search keywords for every given segment from
   * the narration only (never from `visualQuery`). Same account/model selection, rate-limit slot and
   * cooldown handling as {@link generate}; no retry loop over models beyond the schema/capability
   * fallbacks. Returns the usage so the caller can record it like any other content call. Never
   * throws: a failure is `{ ok: false }` and the caller falls back to Pexels (`no_ja_keywords`).
   */
  async extractSegmentKeywords(
    userId: string,
    role: "admin" | "staff",
    input: { providerAccountId: string; language: string; title?: string; segments: Array<{ segmentId: string; narration: string }> },
  ): Promise<SegmentKeywordsOutcome> {
    if (input.segments.length === 0) return { ok: false, code: "VALIDATION_FAILED", message: "Không có segment nào để trích từ khóa" };
    const accounts = await this.providerAccounts.contentGenerationCandidates(userId, role, input.providerAccountId);
    const account = accounts.find((candidate) => candidate.id === input.providerAccountId && candidate.role === "content" && isLiveContentKind(candidate.provider));
    if (!account || !isLiveContentKind(account.provider)) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản content không khả dụng cho trích từ khóa" };
    const snapshots = Array.isArray(account.modelSnapshot) ? account.modelSnapshot as Array<{ modelId: string; status: string }> : [];
    const unavailable = new Set(snapshots.filter((entry) => entry.status === "retired" || entry.status === "unsupported").map((entry) => entry.modelId));
    const ranked = rankContentModels(account.provider, account.availableModels ?? []).filter((modelId) => !unavailable.has(modelId));
    const models = [...(ranked.includes(account.model) ? [account.model] : []), ...ranked.filter((modelId) => modelId !== account.model)];
    if (models.length === 0) return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Không có model khả dụng" };
    const acquired = await this.providerAccounts.acquireContentRequestSlot(account.id);
    if (!acquired) return { ok: false, code: "PROVIDER_RATE_LIMITED", message: "Tài khoản đang trong cooldown hoặc đã đạt concurrency tối đa" };
    try {
      const apiKey = decryptSecret(account.encryptedSecret);
      let lastError: ProviderError | null = null;
      for (const modelId of models) {
        try {
          const result = await extractSegmentKeywords(account.provider, apiKey, modelId, { language: input.language, ...(input.title ? { title: input.title } : {}), segments: input.segments });
          return {
            ok: true,
            keywords: result.keywords,
            rejectedSegmentIds: result.rejectedSegmentIds,
            usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costAmount: result.usage.cost.amount, costCurrency: result.usage.cost.currency, providerRequestId: result.usage.providerRequestId },
            modelId: result.modelId,
            provider: account.provider,
            promptTemplateVersion: result.promptTemplateVersion,
          };
        } catch (error) {
          if (!(error instanceof ProviderError)) return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi trích từ khóa" };
          lastError = error;
          if (error.code === "PROVIDER_CAPABILITY_UNAVAILABLE") {
            await this.providerAccounts.markModelUnusable(account.id, modelId, error.message).catch(() => undefined);
            continue;
          }
          if (error.code === "PROVIDER_SCHEMA_INVALID") continue;
          if (error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED" || error.code === "PROVIDER_AUTH_INVALID") {
            const defaultCooldownMs = error.code === "PROVIDER_QUOTA_EXHAUSTED" ? 15 * 60_000 : error.code === "PROVIDER_AUTH_INVALID" ? 5 * 60_000 : 60_000;
            await this.providerAccounts.cooldownContentAccount(account.id, error.retryAfterMs ?? defaultCooldownMs).catch(() => undefined);
          }
          break;
        }
      }
      return { ok: false, code: lastError?.code ?? "PROVIDER_UNAVAILABLE", message: lastError?.message ?? "Trích từ khóa thất bại" };
    } finally {
      await this.providerAccounts.releaseContentRequestSlot(account.id).catch(() => undefined);
    }
  }

  private buildResponse(
    sourceId: string,
    account: { id: string; provider: string; configVersion: number },
    result: Awaited<ReturnType<typeof generateScriptDraftV2>>,
    selectionReason: "preferred_account" | "automatic_preference",
  ) {
    return {
      sourceId,
      draft: result.draft,
      diagnostics: result.diagnostics,
      providerPin: {
        accountId: account.id,
        provider: account.provider,
        modelId: result.modelId,
        configVersion: account.configVersion,
        promptTemplateVersion: result.promptTemplateVersion,
        providerRequestId: result.usage.providerRequestId,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costAmount: result.usage.cost.amount,
          costCurrency: result.usage.cost.currency,
        },
        rankingVersion: CONTENT_MODEL_RANKING_VERSION,
        selectionReason,
      },
    };
  }
}
