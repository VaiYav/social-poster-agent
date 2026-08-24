import { Module } from "@nestjs/common";
import { BrowserModule } from "../../infrastructure/browser/browser.module.js";
import { AccountsModule } from "../accounts/accounts.module.js";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module.js";
import { CryptoModule } from "../../infrastructure/crypto/crypto.module.js";
import { EmailReaderService } from "../../infrastructure/email/email-reader.service.js";
import { SessionsService } from "./sessions.service.js";
import { SessionsController } from "./sessions.controller.js";
import { WarmupModule } from "./warmup.module.js";

// Note: the SE1 refreshSessionsCron @Cron is discovered by the global
// ScheduleModule.forRoot() registered in AppModule — feature modules must NOT import
// a bare ScheduleModule (it breaks SchedulerOrchestrator resolution in partial graphs).
@Module({
  imports: [BrowserModule, AccountsModule, PrismaModule, CryptoModule, WarmupModule],
  providers: [SessionsService, EmailReaderService],
  controllers: [SessionsController],
  exports: [SessionsService],
})
export class SessionsModule {}
