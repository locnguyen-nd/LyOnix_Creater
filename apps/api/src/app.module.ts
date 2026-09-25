import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthController } from "./health.controller.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { AuthRateLimiter } from "./auth-rate-limit.js";
import { ProviderAccountsController } from "./provider-accounts.controller.js";
import { ProviderAccountsService } from "./provider-accounts.service.js";
import { TiktokOauthController } from "./tiktok-oauth.controller.js";
import { TiktokOauthService } from "./tiktok-oauth.service.js";
import { ChannelsController } from "./channels.controller.js";
import { ChannelsService } from "./channels.service.js";
import { OrganizationController } from "./organization.controller.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { PrismaService } from "./prisma.service.js";
import { GrantsService } from "./grants.service.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { SourcesController } from "./sources.controller.js";
import { SourcesService } from "./sources.service.js";
import { MediaController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { MediaDeliveryController } from "./media-delivery.controller.js";
import { MediaDeliveryService } from "./media-delivery.service.js";
import { AutomationProfilesController } from "./automation-profiles.controller.js";
import { AutomationProfilesService } from "./automation-profiles.service.js";
import { ProviderCapabilitiesController } from "./provider-capabilities.controller.js";
import { ProviderCapabilitiesService } from "./provider-capabilities.service.js";
import { ScriptGenerationController } from "./script-generation.controller.js";
import { ScriptGenerationService } from "./script-generation.service.js";
import { ElevenLabsVoiceController } from "./elevenlabs-voice.controller.js";
import { ElevenLabsVoiceService } from "./elevenlabs-voice.service.js";
import { PexelsController } from "./pexels.controller.js";
import { PexelsService } from "./pexels.service.js";
import { CreatomateTemplatesController } from "./creatomate-templates.controller.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { RenderJobsController } from "./render-jobs.controller.js";
import { RenderJobsService } from "./render-jobs.service.js";
import { ScriptVersionsController } from "./script-versions.controller.js";
import { ScriptVersionsService } from "./script-versions.service.js";
import { AudioVersionsController } from "./audio-versions.controller.js";
import { AudioVersionsService } from "./audio-versions.service.js";
import { VideoProductionsController } from "./video-productions.controller.js";
import { VideoProductionsService } from "./video-productions.service.js";
import { TiktokSyncSchedulerService } from "./tiktok-sync-scheduler.service.js";
import { StudioBridgeController } from "./studio-bridge.controller.js";
import { StudioBridgeService } from "./studio-bridge.service.js";
import { TimelineVersionsController } from "./timeline-versions.controller.js";
import { TimelineVersionsService } from "./timeline-versions.service.js";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    HealthController,
    AuthController,
    ProviderAccountsController,
    ChannelsController,
    TiktokOauthController,
    JobsController,
    OrganizationController,
    ProjectsController,
    SourcesController,
    MediaController,
    MediaDeliveryController,
    AutomationProfilesController,
    ProviderCapabilitiesController,
    ScriptGenerationController,
    ElevenLabsVoiceController,
    PexelsController,
    CreatomateTemplatesController,
    RenderJobsController,
    ScriptVersionsController,
    AudioVersionsController,
    VideoProductionsController,
    StudioBridgeController,
    TimelineVersionsController,
  ],
  providers: [
    PrismaService,
    GrantsService,
    AuthService,
    AuthRateLimiter,
    ProviderAccountsService,
    ChannelsService,
    TiktokOauthService,
    JobsService,
    ProjectsService,
    SourcesService,
    MediaService,
    MediaDeliveryService,
    AutomationProfilesService,
    ProviderCapabilitiesService,
    ScriptGenerationService,
    ElevenLabsVoiceService,
    PexelsService,
    CreatomateTemplatesService,
    RenderJobsService,
    ScriptVersionsService,
    AudioVersionsService,
    VideoProductionsService,
    TiktokSyncSchedulerService,
    StudioBridgeService,
    TimelineVersionsService,
  ],
})
export class AppModule {}
