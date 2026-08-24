import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { TokenBudgetService } from "./token-budget.service.js";

/**
 * P2: LLM cost/usage dashboard endpoints.
 */
@ApiTags("llm")
@Controller("llm")
export class TokenBudgetController {
  constructor(private readonly tokenBudget: TokenBudgetService) {}

  @Get("cost")
  @ApiOperation({ summary: "Get current LLM token/cost usage vs budgets (P2)" })
  @ApiResponse({ status: 200, description: "Hourly and per-run token/cost usage" })
  async getCost() {
    const [orchestrator, generation] = await Promise.all([
      this.tokenBudget.getUsage("orchestrator"),
      this.tokenBudget.getUsage("generation"),
    ]);
    return {
      orchestrator,
      generation,
      generatedAt: new Date().toISOString(),
    };
  }
}
