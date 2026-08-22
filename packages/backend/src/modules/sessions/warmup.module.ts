import { Module } from "@nestjs/common";
import { WarmupService } from "./warmup.service";

/**
 * WarmupModule — standalone module for F20 Session Warm-up Mode.
 *
 * Extracted from SessionsModule to avoid circular dependency:
 * AccountsModule needs WarmupService (to start warm-up on seed),
 * but SessionsModule imports AccountsModule.
 *
 * WarmupService depends only on PrismaService + ConfigService (both global),
 * so this module has no imports — safe to import from both AccountsModule
 * and SessionsModule without creating a cycle.
 */
@Module({
  providers: [WarmupService],
  exports: [WarmupService],
})
export class WarmupModule {}
