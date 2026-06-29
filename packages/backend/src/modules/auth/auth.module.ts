/**
 * AuthModule — JWT cookie auth for the UI (single admin account).
 *
 * Provides:
 *   - AuthService (login, bootstrap, password hashing)
 *   - AuthController (POST /auth/login, POST /auth/logout, GET /auth/me)
 *   - JwtAuthGuard (global APP_GUARD — registered in AppModule)
 *
 * JwtModule is configured with secret from JWT_SECRET env var, 24h expiry.
 * When AUTH_ENABLED=false (default), the guard is pass-through and the auth
 * endpoints still work (login always issues a token if credentials match).
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'dev-insecure-secret'),
        signOptions: { expiresIn: '24h' },
      }),
    }),
  ],
  providers: [AuthService, JwtAuthGuard],
  controllers: [AuthController],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
