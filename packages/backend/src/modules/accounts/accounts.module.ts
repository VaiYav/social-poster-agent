import { Module } from "@nestjs/common";
import { AccountsService } from "./accounts.service.js";
import { AccountSettingsService } from "./account-settings.service.js";
import { AccountsController } from "./accounts.controller.js";
import { WarmupModule } from "../sessions/warmup.module.js";

@Module({
  imports: [WarmupModule],
  providers: [AccountsService, AccountSettingsService],
  controllers: [AccountsController],
  exports: [AccountsService, AccountSettingsService],
})
export class AccountsModule {}
