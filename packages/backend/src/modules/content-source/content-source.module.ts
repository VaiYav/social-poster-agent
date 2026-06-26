import { Module } from '@nestjs/common';
import { ContentModule } from '../../infrastructure/content/content.module';
import { ContentSourceService } from './content-source.service';
import { ContentSourceController } from './content-source.controller';

@Module({
  imports: [ContentModule],
  providers: [ContentSourceService],
  controllers: [ContentSourceController],
  exports: [ContentSourceService],
})
export class ContentSourceModule {}
