import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ContentReader } from './content-reader';
import { DbContentReader } from './db-content-reader';
import { TopicGenerationService } from './topic-generation.service';
import { IContentPort } from '../../domain/ports/content.port.js';
import { PrismaModule } from '../prisma/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { ScheduleModule } from '@nestjs/schedule';

/**
 * ContentModule — wires the IContentPort adapter.
 *
 * Auto-detection: if CONTENT_AGENT_PLATFORM_PATH points to a real directory,
 * ContentReader (filesystem-based, reads CAP repo) is used. Otherwise,
 * DbContentReader (DB-backed, LLM-generated topics) is used.
 *
 * This makes the app fully self-contained — no sibling repo required.
 */
@Module({
  imports: [PrismaModule, LlmModule, ScheduleModule],
  providers: [
    ContentReader,
    DbContentReader,
    TopicGenerationService,
    {
      provide: IContentPort,
      useFactory: (config: ConfigService, dbReader: DbContentReader, fsReader: ContentReader) => {
        const capPath = config.get<string>('CONTENT_AGENT_PLATFORM_PATH', '');
        if (capPath) {
          const runsDir = join(capPath, 'runs');
          if (existsSync(runsDir)) {
            return fsReader;
          }
        }
        // CAP not available — use DB-backed reader
        return dbReader;
      },
      inject: [ConfigService, DbContentReader, ContentReader],
    },
  ],
  exports: [ContentReader, DbContentReader, TopicGenerationService, IContentPort],
})
export class ContentModule {}
