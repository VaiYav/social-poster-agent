/**
 * Auth controller — login/logout/me endpoints for UI authentication.
 *
 * JWT is transported in an httpOnly cookie (`spa_token`):
 *   - httpOnly: not accessible from JS (XSS-safe)
 *   - sameSite=lax: sent on same-origin requests (Vite proxy / nginx)
 *   - secure: true in production (requires HTTPS)
 *   - maxAge: 24h (matches JWT expiry)
 *
 * SSE/EventSource works automatically — the browser sends the cookie with
 * same-origin GET requests without any special handling.
 */
import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDtoSchema, type LoginDto, type AuthUser } from '@spa/shared';
import { parseBool } from '../../infrastructure/config/parse-bool';

const COOKIE_NAME = 'spa_token';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly isProduction: boolean;
  private readonly authEnabled: boolean;
  private readonly adminUsername: string;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
    this.authEnabled = parseBool(this.configService.get<string>('AUTH_ENABLED', 'false'));
    this.adminUsername = this.configService.get<string>('ADMIN_USERNAME', 'admin') ?? 'admin';
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with username/password — sets httpOnly JWT cookie' })
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): Promise<{ user: AuthUser }> {
    // Validate with Zod schema (shared contract)
    const parsed = LoginDtoSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const { token, user } = await this.authService.login(parsed.data.username, parsed.data.password);

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      // Cross-origin (Vercel → Railway): sameSite=none + secure required.
      // Same-origin (dev / Vite proxy): sameSite=lax is sufficient.
      sameSite: this.isProduction ? 'none' : 'lax',
      secure: this.isProduction,
      maxAge: 24 * 60 * 60 * 1000, // 24h — matches JWT expiry
      path: '/',
    });

    this.logger.log(`Admin "${user.username}" logged in`);
    return { user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear the auth cookie' })
  async logout(@Res({ passthrough: true }) res: Response): Promise<{ success: true }> {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return { success: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated admin (from JWT)' })
  async me(@Req() req: Request): Promise<{ user: AuthUser }> {
    const payload = (req as Request & { user?: { sub: string; username: string } }).user;
    if (!payload) {
      if (!this.authEnabled) {
        return { user: { id: 'admin', username: this.adminUsername, role: 'admin' } as AuthUser };
      }
      throw new UnauthorizedException('Not authenticated');
    }

    const user = await this.authService.getAdminById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('Admin account not found');
    }

    return { user };
  }
}

export { COOKIE_NAME };
