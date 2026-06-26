import { Module } from '@nestjs/common';
import { ContentReader } from './content-reader';
import { IContentPort } from '../../domain/ports/content.port.js';

@Module({
  providers: [
    ContentReader,
    { provide: IContentPort, useExisting: ContentReader },
  ],
  exports: [ContentReader, IContentPort],
})
export class ContentModule {}
