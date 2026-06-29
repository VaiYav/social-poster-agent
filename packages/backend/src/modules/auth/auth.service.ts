/**
 * AuthService — JWT cookie auth for the UI (single admin account).
 *
 * - Password hashing: Node.js built-in `crypto.scrypt` (no external deps).
 *   Format: "saltHex:hashHex" (64-byte salt, 64-byte hash).
 * - Admin bootstrap: on module init, if ADMIN_USERNAME/ADMIN_PASSWORD env vars
 *   are set, creates or updates the admin account so the env is the source of
 *   truth for the password. If ADMIN_PASSWORD is empty, bootstrap is skipped
 *   (the admin must be created/managed another way — e.g. a future CLI).
 * - JWT: signed with JWT_SECRET, expires in 24h, payload `{ sub, username }`.
 */
import { Injectable, Logger, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '@spa/shared';

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALTLEN = 64;

export interface JwtPayload {
  sub: string;
  username: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  private readonly adminUsername: string;
  private readonly adminPassword: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.adminUsername = this.configService.get<string>('ADMIN_USERNAME', 'admin') ?? 'admin';
    this.adminPassword = this.configService.get<string>('ADMIN_PASSWORD', '') ?? '';
  }

  async onModuleInit(): Promise<void> {
    await this.bootstrapAdmin();
  }

  /**
   * Create or update the admin account from env vars.
   * - If ADMIN_PASSWORD is empty → skip (warn).
   * - If admin doesn't exist → create with hashed env password.
   * - If admin exists but env password differs → update hash (env is source of truth).
   */
  private async bootstrapAdmin(): Promise<void> {
    if (!this.adminPassword) {
      this.logger.warn(
        'ADMIN_PASSWORD not set — admin account will not be bootstrapped. Set ADMIN_USERNAME/ADMIN_PASSWORD in .env to enable UI login.',
      );
      return;
    }

    const existing = await this.prisma.admin.findUnique({
      where: { username: this.adminUsername },
    });

    if (!existing) {
      const hash = this.hashPassword(this.adminPassword);
      await this.prisma.admin.create({
        data: { username: this.adminUsername, passwordHash: hash },
      });
      this.logger.log(`Admin account "${this.adminUsername}" created from env vars`);
      return;
    }

    // Update password if env changed
    if (!this.verifyPassword(this.adminPassword, existing.passwordHash)) {
      const hash = this.hashPassword(this.adminPassword);
      await this.prisma.admin.update({
        where: { username: this.adminUsername },
        data: { passwordHash: hash },
      });
      this.logger.log(`Admin password for "${this.adminUsername}" updated from env`);
    }
  }

  /**
   * Login: verify credentials and issue a JWT.
   * Throws UnauthorizedException on bad username/password.
   */
  async login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const admin = await this.prisma.admin.findUnique({ where: { username } });
    if (!admin || !this.verifyPassword(password, admin.passwordHash)) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const payload: JwtPayload = { sub: admin.id, username: admin.username };
    let token: string;
    try {
      token = await this.jwtService.signAsync(payload);
    } catch (err) {
      // signAsync throws when JWT_SECRET is unset/misconfigured (no weak fallback).
      // Surface a clear 500 instead of crashing the request.
      this.logger.error(
        `Failed to sign JWT: ${(err as Error).message}. Set JWT_SECRET (≥32 chars) to enable login.`,
      );
      throw new UnauthorizedException('Authentication is misconfigured');
    }

    return {
      token,
      user: { id: admin.id, username: admin.username },
    };
  }

  /**
   * Verify a JWT token. Returns the payload or null.
   */
  async verifyToken(token: string): Promise<JwtPayload | null> {
    try {
      return await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      return null;
    }
  }

  /**
   * Get admin user by id (for /auth/me).
   */
  async getAdminById(id: string): Promise<AuthUser | null> {
    const admin = await this.prisma.admin.findUnique({ where: { id } });
    if (!admin) return null;
    return { id: admin.id, username: admin.username };
  }

  // ── Password hashing (scrypt) ──────────────────────────────────

  hashPassword(password: string): string {
    const salt = randomBytes(SCRYPT_SALTLEN);
    const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  verifyPassword(password: string, stored: string): boolean {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;

    try {
      const salt = Buffer.from(saltHex, 'hex');
      const expectedHash = Buffer.from(hashHex, 'hex');
      const actualHash = scryptSync(password, salt, SCRYPT_KEYLEN);

      if (actualHash.length !== expectedHash.length) return false;
      return timingSafeEqual(actualHash, expectedHash);
    } catch {
      return false;
    }
  }
}
