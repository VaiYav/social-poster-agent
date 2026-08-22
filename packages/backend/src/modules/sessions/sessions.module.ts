import { Module } from "@nestjs/common";
import { BrowserModule } from "../../infrastructure/browser/browser.module";
import { AccountsModule } from "../accounts/accounts.module";
import { PrismaModule } from "../../infrastructure/prisma/prisma.module";
import { CryptoModule } from "../../infrastructure/crypto/crypto.module";
import { EmailReaderService } from "../../infrastructure/email/email-reader.service.js";
import { SessionsService } from "./sessions.service";
import { SessionsController } from "./sessions.controller";
import { WarmupModule } from "./warmup.module";

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
