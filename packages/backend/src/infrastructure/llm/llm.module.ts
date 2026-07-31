import { Module } from '@nestjs/common';
import { LlmService } from './llm.service';
import { LlmController } from './llm.controller';
import { TokenBudgetController } from './token-budget.controller.js';
import { ILlmPort } from '../../domain/ports/llm.port.js';
import { TokenBudgetService } from './token-budget.service.js';

@Module({
  controllers: [LlmController, TokenBudgetController],
  providers: [
    LlmService,
    TokenBudgetService,
    { provide: ILlmPort, useExisting: LlmService },
  ],
  exports: [LlmService, ILlmPort, TokenBudgetService],
})
export class LlmModule {}
