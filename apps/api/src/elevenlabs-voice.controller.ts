import { Body, Controller, Delete, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { requireCsrf, requireUser, requestId } from "./auth.helpers.js";
import { AuthService } from "./auth.service.js";
import { normalizedError, success } from "./envelopes.js";
import { ElevenLabsVoiceService, type CloneConsentInput, type CloneSampleFileInput } from "./elevenlabs-voice.service.js";

type CreateCloneBody = { name?: string; description?: string; consent?: CloneConsentInput; files?: CloneSampleFileInput[] };
type TtsBody = { projectId?: string; text?: string; modelId?: string; folderId?: string | null };

@Controller()
export class ElevenLabsVoiceController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ElevenLabsVoiceService) private readonly voices: ElevenLabsVoiceService,
  ) {}

  @Get("provider-accounts/:id/elevenlabs/voices")
  async list(@Param("id") id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const outcome = await this.voices.listVoices(id);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Get("provider-accounts/:id/elevenlabs/voices/:voiceId")
  async get(@Param("id") id: string, @Param("voiceId") voiceId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await requireUser(request, response, this.auth);
    const outcome = await this.voices.getVoice(id, voiceId);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Post("provider-accounts/:id/elevenlabs/voice-clones")
  async createClone(@Param("id") id: string, @Body() body: CreateCloneBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.name?.trim() || !body.consent || !Array.isArray(body.files) || body.files.length === 0) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu name/consent/files cho voice clone", requestId(response));
    }
    const outcome = await this.voices.createClone(id, user.id, {
      name: body.name,
      ...(body.description ? { description: body.description } : {}),
      consent: body.consent,
      files: body.files,
    }, user.role);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  @Delete("provider-accounts/:id/elevenlabs/voices/:voiceId")
  async remove(@Param("id") id: string, @Param("voiceId") voiceId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const outcome = await this.voices.deleteVoice(id, voiceId, user.id);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }

  /**
   * Voice Picker preview for a voice without a provider `previewUrl`: a fixed sample sentence in `language`, as audio bytes.
   * Nothing is stored in a project; the service caches it, so pressing Play again costs nothing.
   */
  @Post("provider-accounts/:id/elevenlabs/voices/:voiceId/preview")
  async preview(@Param("id") id: string, @Param("voiceId") voiceId: string, @Body() body: { language?: unknown }, @Req() request: Request, @Res() response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    const language = body?.language === "vi" || body?.language === "en" || body?.language === "ja" || body?.language === "ko" ? body.language : "en";
    const outcome = await this.voices.previewVoice(id, voiceId, user.id, user.role, language);
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    response.setHeader("content-type", outcome.data.mimeType);
    response.setHeader("cache-control", "private, max-age=86400");
    response.setHeader("x-preview-cache", outcome.data.cached ? "hit" : "miss");
    response.setHeader("x-preview-voice-id", outcome.data.voiceId);
    response.setHeader("x-preview-model-id", outcome.data.modelId);
    response.status(200).end(outcome.data.audio);
  }

  @Post("provider-accounts/:id/elevenlabs/voices/:voiceId/tts")
  async tts(@Param("id") id: string, @Param("voiceId") voiceId: string, @Body() body: TtsBody, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const { user, session } = await requireUser(request, response, this.auth);
    requireCsrf(request, response, session);
    if (!body.projectId?.trim() || !body.text?.trim()) {
      throw normalizedError("VALIDATION_FAILED", "Thiếu projectId/text để tạo audio", requestId(response));
    }
    const outcome = await this.voices.generateTts(id, user.id, user.role, {
      projectId: body.projectId,
      voiceId,
      text: body.text,
      ...(body.modelId ? { modelId: body.modelId } : {}),
      folderId: body.folderId ?? null,
    });
    if (!outcome.ok) throw normalizedError(outcome.code, outcome.message, requestId(response), outcome.status ?? 400, [], outcome.retryable ?? false);
    return success(outcome.data, requestId(response));
  }
}
