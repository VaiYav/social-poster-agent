import { Module } from "@nestjs/common";
import { LlmService } from "./llm.service.js";
import { LlmController } from "./llm.controller.js";
import { TokenBudgetController } from "./token-budget.controller.js";
import { ILlmPort } from "../../domain/ports/llm.port.js";
import { TokenBudgetService } from "./token-budget.service.js";
import { ResilienceModule } from "../../modules/resilience/resilience.module.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { LlmUsageLedgerService } from "./llm-usage-ledger.service.js";
import { PromptCompressionService } from "./prompt-compression.service.js";

@Module({
  imports: [ResilienceModule, PrismaModule],
  controllers: [LlmController, TokenBudgetController],
  providers: [
    LlmService,
    TokenBudgetService,
    LlmUsageLedgerService,
    PromptCompressionService,
    { provide: ILlmPort, useExisting: LlmService },
  ],
  exports: [LlmService, ILlmPort, TokenBudgetService, LlmUsageLedgerService, PromptCompressionService],
})
export class LlmModule {}
