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
import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AdminGuard } from './admin.guard';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

/** Auth module is global so AdminGuard is available to any controller. */
@Global()
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET', '') ?? '';
        // No weak fallback. If AUTH_ENABLED=false the guard is pass-through and
        // login is effectively unused; if a caller hits /auth/login without a
        // configured secret, AuthService.login throws (misconfigured) rather
        // than minting tokens signed with a guessable default.
        if (!secret) {
          // eslint-disable-next-line no-console
          console.warn(
            '[AuthModule] JWT_SECRET not set — /auth/login will reject credentials. ' +
              'Set JWT_SECRET (≥32 chars) to enable UI login.',
          );
        }
        return {
          secret: secret || undefined, // undefined → JwtService throws on sign (fail-safe)
          signOptions: { expiresIn: '24h' },
        };
      },
    }),
  ],
  providers: [AuthService, JwtAuthGuard, AdminGuard, LoginRateLimitGuard],
  controllers: [AuthController],
  exports: [AuthService, JwtAuthGuard, AdminGuard, LoginRateLimitGuard, JwtModule],
})
export class AuthModule {}
