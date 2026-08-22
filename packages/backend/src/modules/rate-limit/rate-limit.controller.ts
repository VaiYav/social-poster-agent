import { Controller, Get, Post, Param, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { RateLimitService } from "./rate-limit.service";

@ApiTags("rate-limit")
@Controller("rate-limit")
export class RateLimitController {
  constructor(private readonly rateLimitService: RateLimitService) {}

  @Get(":network/status")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get current rate limit status for a network" })
  @ApiResponse({
    status: 200,
    description: "Rate limit status (daily/weekly counts, limits, last post time)",
  })
  async getStatus(@Param("network") network: string) {
    return this.rateLimitService.getStatus(network.toUpperCase());
  }

  @Post(":network/reset")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset rate limit counters for a network" })
  @ApiResponse({ status: 200, description: "Rate limit counters reset" })
  async reset(@Param("network") network: string) {
    await this.rateLimitService.resetRateLimit(network.toUpperCase());
    return { message: `Rate limit counters reset for ${network.toUpperCase()}` };
  }
}
