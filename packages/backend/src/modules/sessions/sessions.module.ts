import { Module } from '@nestjs/common';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { AccountsModule } from '../accounts/accounts.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { WarmupService } from './warmup.service';

@Module({
  imports: [BrowserModule, AccountsModule, PrismaModule],
  providers: [SessionsService, WarmupService],
  controllers: [SessionsController],
  exports: [SessionsService, WarmupService],
})
export class SessionsModule {}
