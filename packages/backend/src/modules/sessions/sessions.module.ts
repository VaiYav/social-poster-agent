import { Module } from '@nestjs/common';
import { BrowserModule } from '../../infrastructure/browser/browser.module';
import { AccountsModule } from '../accounts/accounts.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { CryptoModule } from '../../infrastructure/crypto/crypto.module';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { WarmupModule } from './warmup.module';

@Module({
  imports: [BrowserModule, AccountsModule, PrismaModule, CryptoModule, WarmupModule],
  providers: [SessionsService],
  controllers: [SessionsController],
  exports: [SessionsService],
})
export class SessionsModule {}
