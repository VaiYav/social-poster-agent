import { Controller, Get, Post, Body, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { LlmService } from "./llm.service.js";

/**
 * LLM management endpoints.
 *
 * Extracted from GenerationController so that generation and LLM infrastructure
 * concerns live in separate controllers/modules.
 */
@ApiTags("llm")
@Controller("generation")
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Get("models")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "List available LLM models for model picker (F3)" })
  @ApiResponse({ status: 200, description: "List of available LLM providers and models" })
  async listModels() {
    return this.llmService.getAvailableModels();
  }

  @Get("provider-status")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get LLM provider circuit breaker status" })
  @ApiResponse({ status: 200, description: "Provider status with circuit breaker state" })
  async getProviderStatus() {
    return this.llmService.getProviderStatus();
  }

  @Post("reset-circuit-breakers")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reset circuit breakers for LLM providers (after fixing auth/billing issues)",
  })
  @ApiResponse({ status: 200, description: "Circuit breakers reset" })
  async resetCircuitBreakers(@Body() body: { providers?: string[] }) {
    this.llmService.resetCircuitBreakers(body.providers);
    return { message: "Circuit breakers reset", providers: body.providers ?? "all" };
  }
}
