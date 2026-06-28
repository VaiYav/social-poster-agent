import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { PromptRegistryModule } from './prompt-registry.module.js';

@Module({
  imports: [PromptRegistryModule],
  providers: [
    LlmService,
    { provide: ILlmPort, useExisting: LlmService },
  ],
  exports: [LlmService, ILlmPort],
})
export class LlmModule {}
