import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ContentReader } from "./content-reader.js";
import { DbContentReader } from "./db-content-reader.js";
import { TopicGenerationService } from "./topic-generation.service";
import { ContentAdapterRegistry } from "./adapters/content-adapter.registry.js";
import { IContentPort } from "../../domain/ports/content.port.js";
import { CONTENT_ADAPTERS } from "./adapters/content-adapter.interface.js";
import { buildContentAdapters } from "./adapters/content-adapter.factory.js";
import { PrismaModule } from "../prisma/prisma.module";
import { LlmModule } from "../llm/llm.module";
import { PrismaService } from "../prisma/prisma.service";

/**
 * ContentModule — wires the IContentPort adapter.
 *
 * Auto-detection: if CONTENT_AGENT_PLATFORM_PATH points to a real directory,
 * ContentReader (filesystem-based, reads CAP repo) is used. Otherwise,
 * DbContentReader (DB-backed, LLM-generated topics) is used.
 *
 * ContentAdapterRegistry aggregates registered IContentAdapter implementations,
 * making the module extensible for future sources (RSS, API, etc.).
 */
// NOTE (quality pass): do NOT import the bare `ScheduleModule` here — the bare
// class module instantiates SchedulerOrchestrator WITHOUT providing
// SchedulerRegistry (only forRoot() provides it). In prod the global
// ScheduleModule.forRoot() in AppModule supplies SchedulerRegistry for
// TopicGenerationService; the bare import only broke isolated module tests.
@Module({
  imports: [PrismaModule, LlmModule],
  providers: [
    ContentReader,
    DbContentReader,
    TopicGenerationService,
    ContentAdapterRegistry,
    {
      provide: IContentPort,
      useExisting: ContentAdapterRegistry,
    },
    {
      provide: CONTENT_ADAPTERS,
      useFactory: async (
        config: ConfigService,
        prisma: PrismaService,
        fsReader: ContentReader,
        dbReader: DbContentReader,
      ) => {
        return buildContentAdapters({ configService: config, prisma, fsReader, dbReader });
      },
      inject: [ConfigService, PrismaService, ContentReader, DbContentReader],
    },
  ],
  exports: [ContentReader, DbContentReader, TopicGenerationService, IContentPort],
})
export class ContentModule {}
