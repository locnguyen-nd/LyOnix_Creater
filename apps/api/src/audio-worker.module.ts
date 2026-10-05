import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import { GrantsService } from "./grants.service.js";
import { MediaService } from "./media.service.js";
import { ElevenLabsVoiceService } from "./elevenlabs-voice.service.js";
import { AudioVersionsService } from "./audio-versions.service.js";

@Module({ providers: [PrismaService, GrantsService, MediaService, ElevenLabsVoiceService, AudioVersionsService] })
export class AudioWorkerModule {}
