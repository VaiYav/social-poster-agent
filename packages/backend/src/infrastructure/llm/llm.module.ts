import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';
import { ILlmPort } from '../../domain/ports/llm.port.js';

@Module({
  controllers: [LlmController],
  providers: [
    LlmService,
    { provide: ILlmPort, useExisting: LlmService },
  ],
  exports: [LlmService, ILlmPort],
})
export class LlmModule {}
