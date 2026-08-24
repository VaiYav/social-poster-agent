import { Module } from "@nestjs/common";
import { TrendingService } from "./trending.service.js";
import { TrendingScraperService } from "./trending-scraper.service.js";
import { TrendingController } from "./trending.controller.js";
import { BrowserModule } from "../../infrastructure/browser/browser.module.js";
import { LlmModule } from "../../infrastructure/llm/llm.module.js";
import { SessionsModule } from "../sessions/sessions.module.js";

@Module({
  imports: [BrowserModule, LlmModule, SessionsModule],
  providers: [TrendingService, TrendingScraperService],
  controllers: [TrendingController],
  exports: [TrendingService, TrendingScraperService],
})
export class TrendingModule {}
