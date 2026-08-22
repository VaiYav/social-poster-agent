import { Module } from "@nestjs/common";
import { CanonicalUrlService } from "./canonical-url.service.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";

/**
 * CanonicalModule — provides CanonicalUrlService for POSSE canonical URL management.
 *
 * Imported by SyndicationModule (when SYNDICATION_ENABLED=true).
 */
@Module({
  imports: [PrismaModule],
  providers: [CanonicalUrlService],
  exports: [CanonicalUrlService],
})
export class CanonicalModule {}
