import { Module } from "@nestjs/common";
import { LinkModule } from "../../infrastructure/link/link.module.js";
import { LinkAttributionService } from "./link-attribution.service.js";
import { LinkAttributionController } from "./link-attribution.controller.js";

/**
 * LinkAttributionModule — M2.1/M2.4: assigns trackable CTA links to posts
 * before publishing (graceful degradation to direct UTM URLs) and exposes
 * the conversion summary feed for the dashboard.
 */
@Module({
  imports: [LinkModule],
  providers: [LinkAttributionService],
  controllers: [LinkAttributionController],
  exports: [LinkAttributionService],
})
export class LinkAttributionModule {}
