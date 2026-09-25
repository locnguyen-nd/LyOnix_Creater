import { Inject, Injectable } from "@nestjs/common";
import {
  ProviderError,
  generateScriptDraftV2,
  isContentLanguageV2,
  isLiveContentKind,
  isScriptSourceKind,
} from "@lyonix/providers";
import type { ErrorCode, ScriptDraftV2GenerationResponse } from "@lyonix/contracts";
import { PrismaService } from "./prisma.service.js";
import { SourcesService } from "./sources.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { decryptSecret } from "./secret-crypto.js";

export type GenerateScriptDraftInput = { providerAccountId: string; language?: string; direction?: string };

export type GenerateScriptDraftOutcome =
  | { ok: true; response: ScriptDraftV2GenerationResponse }
  | { ok: false; code: ErrorCode; message: string; status?: number; retryable?: boolean };

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
    @Inject(PrismaService) private readonly prisma: PrismaService,
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
    const account = await this.prisma.providerAccount.findFirst({ where: { id: input.providerAccountId, deletedAt: null } });
    if (!account) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "Tài khoản provider không tồn tại hoặc đã bị xóa", status: 503 };
    if (account.role !== "content" || !isLiveContentKind(account.provider)) {
      return { ok: false, code: "PROVIDER_CAPABILITY_UNAVAILABLE", message: "Tài khoản không phải content provider hỗ trợ (openai|gemini|xai)", status: 503 };
    }
    const usable = account.isFake ? process.env.NODE_ENV === "test" : account.status === "verified";
    if (!usable) return { ok: false, code: "PROVIDER_NOT_CONFIGURED", message: `Tài khoản ${account.provider} chưa verify`, status: 503 };

    const language = input.language && isContentLanguageV2(input.language) ? input.language : "vi";
    const apiKey = decryptSecret(account.encryptedSecret);

    // Rotation order: the account's currently pinned model first, then every other model this
    // account already proved reachable (verify-time discovery/probe) or previously generated
    // with successfully - never a model outside what this specific account/key can see.
    const candidates = [account.model, ...(account.availableModels ?? []).filter((modelId) => modelId !== account.model)];
    let lastError: ProviderError | null = null;
    for (const modelId of candidates) {
      try {
        const result = await generateScriptDraftV2(account.provider, apiKey, modelId, {
          sourceType: source.type,
          sourceText,
          originRef: source.originRef,
          language,
          ...(input.direction ? { direction: input.direction } : {}),
        });
        if (result.modelId !== account.model) {
          await this.providerAccounts.repinModel(account.id, result.modelId).catch(() => undefined);
        }
        return { ok: true, response: this.buildResponse(sourceId, account, result) };
      } catch (error) {
        if (!(error instanceof ProviderError)) return { ok: false, code: "PROVIDER_UNAVAILABLE", message: "Lỗi mạng hoặc timeout khi gọi provider", status: 502 };
        lastError = error;
        // V00-10: a live generate call is itself real evidence the pinned model is retired/unsupported
        // for this account right now - persist that into the account's model snapshot instead of only
        // surfacing a one-off error, so the account stops offering it and requires explicit reselection.
        if (error.code === "PROVIDER_CAPABILITY_UNAVAILABLE") {
          await this.providerAccounts.markModelUnusable(account.id, modelId, error.message).catch(() => undefined);
        }
        // Quota/rate-limit/capability failures are model-specific, not account-wide - rotate to the
        // next candidate instead of stopping the whole generation. Auth/content/schema/timeout
        // failures would fail identically on any other model for this account, so surface them
        // immediately rather than burning the rest of the candidate list for nothing.
        const rotatable = error.code === "PROVIDER_QUOTA_EXHAUSTED" || error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_CAPABILITY_UNAVAILABLE";
        if (!rotatable) break;
      }
    }
    const error = lastError!;
    const switchable = error.code === "PROVIDER_RATE_LIMITED" || error.code === "PROVIDER_QUOTA_EXHAUSTED" || error.code === "PROVIDER_AUTH_INVALID";
    return {
      ok: false,
      code: error.code,
      message: error.code === "PROVIDER_CAPABILITY_UNAVAILABLE"
        ? "Model không còn khả dụng cho tài khoản này. Chọn model khác trong Cài đặt provider."
        : error.code === "PROVIDER_QUOTA_EXHAUSTED" && candidates.length > 1
          ? "Toàn bộ model khả dụng của tài khoản này đều hết quota."
          : providerErrorMessage[error.code] ?? "Nhà cung cấp từ chối generate",
      status: switchable ? 429 : 502,
      retryable: error.retryable,
    };
  }

  private buildResponse(
    sourceId: string,
    account: { id: string; provider: string; configVersion: number },
    result: Awaited<ReturnType<typeof generateScriptDraftV2>>,
  ) {
    return {
      sourceId,
      draft: result.draft,
      providerPin: {
        accountId: account.id,
        provider: account.provider,
        modelId: result.modelId,
        configVersion: account.configVersion,
        promptTemplateVersion: result.promptTemplateVersion,
      },
    };
  }
}
