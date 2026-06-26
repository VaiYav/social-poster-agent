import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * PrismaModule is @Global so that every module that injects PrismaService
 * (AccountsModule, PostsModule, SessionsModule, GenerationModule,
 * HealthModule, etc.) can access it without each importing PrismaModule
 * explicitly — mirroring the global ConfigModule pattern.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
