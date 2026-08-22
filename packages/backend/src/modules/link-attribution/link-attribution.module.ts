import { Module } from "@nestjs/common";
import { LinkModule } from "../../infrastructure/link/link.module";
import { LinkAttributionService } from "./link-attribution.service";

/**
 * LinkAttributionModule — M2.1: assigns trackable CTA links to posts before
 * publishing, with graceful degradation to direct UTM URLs.
 */
@Module({
  imports: [LinkModule],
  providers: [LinkAttributionService],
  exports: [LinkAttributionService],
})
export class LinkAttributionModule {}
