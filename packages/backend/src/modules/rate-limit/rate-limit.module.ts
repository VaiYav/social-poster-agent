import { Module } from "@nestjs/common";
import { RateLimitService } from "./rate-limit.service.js";
import { RateLimitController } from "./rate-limit.controller.js";

@Module({
  controllers: [RateLimitController],
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
