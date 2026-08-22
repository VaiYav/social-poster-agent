import { Module } from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { AccountSettingsService } from "./account-settings.service";
import { AccountsController } from "./accounts.controller";
import { WarmupModule } from "../sessions/warmup.module";

@Module({
  imports: [WarmupModule],
  providers: [AccountsService, AccountSettingsService],
  controllers: [AccountsController],
  exports: [AccountsService, AccountSettingsService],
})
export class AccountsModule {}
