import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseBool } from '../../infrastructure/config/parse-bool.js';

/**
 * AdminGuard — requires an authenticated user with role 'admin'.
 *
 * When AUTH_ENABLED=false (dev / VPN-only) the guard is a pass-through so
 * admin endpoints remain reachable without a JWT.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const authEnabled = parseBool(this.configService.get<string>('AUTH_ENABLED', 'false'));
    if (!authEnabled) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as { role?: string } | undefined;
    if (!user || user.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
