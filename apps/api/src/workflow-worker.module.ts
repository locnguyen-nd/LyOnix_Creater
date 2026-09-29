import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import { GrantsService } from "./grants.service.js";
import { MediaService } from "./media.service.js";
import { MediaDeliveryService } from "./media-delivery.service.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { SourcesService } from "./sources.service.js";
import { ScriptGenerationService } from "./script-generation.service.js";
import { ScriptVersionsService } from "./script-versions.service.js";
import { ElevenLabsVoiceService } from "./elevenlabs-voice.service.js";
import { AudioVersionsService } from "./audio-versions.service.js";
import { PexelsService } from "./pexels.service.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { RenderJobsService } from "./render-jobs.service.js";
import { TimelineVersionsService } from "./timeline-versions.service.js";
import { WorkflowRunnerService } from "./workflow-runner.service.js";

/** VE2E-06: providers for `workflow-worker-main.ts`, the background process that actually executes the Auto DAG — never wired into `apps/api`'s HTTP `AppModule` request path. */
@Module({
  providers: [
    PrismaService,
    GrantsService,
    MediaService,
    MediaDeliveryService,
    ProviderAccountsService,
    SourcesService,
    ScriptGenerationService,
    ScriptVersionsService,
    ElevenLabsVoiceService,
    AudioVersionsService,
    PexelsService,
    CreatomateTemplatesService,
    RenderJobsService,
    TimelineVersionsService,
    WorkflowRunnerService,
  ],
})
export class WorkflowWorkerModule {}
