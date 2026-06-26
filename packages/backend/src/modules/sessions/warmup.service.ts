import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SocialNetwork, SessionStatus } from '@prisma/client';

/**
 * F20: Session Warm-up Mode — gradual ramp for new accounts.
 *
 * New accounts start in WARMUP phase:
 * - Days 1-2: browse-only (no posting, no interactions)
 * - Days 3-5: light interactions (likes only, 1-2/day)
 * - Days 6-7: moderate (posts + likes, 1 post/day)
 * - Day 8+: full activity (ACTIVE status)
 *
 * This mimics human account behavior and reduces ban risk.
 *
 * Warm-up is opt-in: set SOCIAL_{NETWORK}_WARMUP=true in env to enable
 * for a new account. The warm-up starts when the account is first seeded.
 */
@Injectable()
export class WarmupService {
  private readonly logger = new Logger(WarmupService.name);
  private readonly defaultWarmupDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.defaultWarmupDays = this.configService?.get<number>('WARMUP_DAYS_TOTAL', 7) ?? 7;
  }

  /**
   * Start warm-up for a new account.
   * Called when an account is seeded with warmupEnabled=true.
   */
  async startWarmup(accountId: string): Promise<void> {
    await this.prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        warmupEnabled: true,
        warmupStartedAt: new Date(),
        warmupDaysTotal: this.defaultWarmupDays,
      },
    });

    // Create a WARMUP session
    await this.prisma.session.create({
      data: {
        accountId,
        storageState: { cookies: [], origins: [] },
        status: 'WARMUP' as SessionStatus,
      },
    });

    this.logger.log(`Warm-up started for account ${accountId} (${this.defaultWarmupDays} days)`);
  }

  /**
   * Check if an account is still in warm-up phase.
   * Returns the warm-up phase info (or null if not in warm-up).
   */
  async getWarmupStatus(accountId: string): Promise<WarmupStatus | null> {
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: accountId },
    });

    if (!account || !account.warmupEnabled) return null;

    if (!account.warmupStartedAt) return null;

    const daysElapsed = Math.floor(
      (Date.now() - account.warmupStartedAt.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Check if warm-up is complete
    if (daysElapsed >= account.warmupDaysTotal) {
      await this.completeWarmup(accountId);
      return null;
    }

    const phase = this.getWarmupPhase(daysElapsed, account.warmupDaysTotal);

    return {
      accountId,
      daysElapsed,
      daysTotal: account.warmupDaysTotal,
      phase,
      canPost: phase === 'moderate' || phase === 'full',
      canInteract: phase !== 'browse-only',
      maxInteractionsPerDay: this.getMaxInteractions(phase),
    };
  }

  /**
   * Check if posting is allowed for an account (considering warm-up).
   * Returns true if account is not in warm-up OR is in moderate/full phase.
   */
  async canPost(accountId: string): Promise<boolean> {
    const status = await this.getWarmupStatus(accountId);
    if (!status) return true; // not in warm-up — full access
    return status.canPost;
  }

  /**
   * Complete warm-up — transition account to ACTIVE.
   */
  async completeWarmup(accountId: string): Promise<void> {
    await this.prisma.socialAccount.update({
      where: { id: accountId },
      data: { warmupEnabled: false },
    });

    // Update WARMUP sessions to ACTIVE
    await this.prisma.session.updateMany({
      where: { accountId, status: 'WARMUP' as SessionStatus },
      data: { status: SessionStatus.ACTIVE },
    });

    this.logger.log(`Warm-up completed for account ${accountId} — now ACTIVE`);
  }

  /**
   * Determine warm-up phase based on days elapsed.
   */
  private getWarmupPhase(daysElapsed: number, totalDays: number): WarmupPhase {
    if (totalDays <= 3) {
      // Short warm-up: day 1 browse, day 2 light, day 3+ full
      if (daysElapsed < 1) return 'browse-only';
      if (daysElapsed < 2) return 'light';
      return 'full';
    }

    // Standard 7-day warm-up
    if (daysElapsed < 2) return 'browse-only';
    if (daysElapsed < 5) return 'light';
    if (daysElapsed < totalDays) return 'moderate';
    return 'full';
  }

  /**
   * Get max interactions per day based on warm-up phase.
   */
  private getMaxInteractions(phase: WarmupPhase): number {
    switch (phase) {
      case 'browse-only': return 0;
      case 'light': return 2;
      case 'moderate': return 5;
      case 'full': return 15;
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export type WarmupPhase = 'browse-only' | 'light' | 'moderate' | 'full';

export interface WarmupStatus {
  accountId: string;
  daysElapsed: number;
  daysTotal: number;
  phase: WarmupPhase;
  canPost: boolean;
  canInteract: boolean;
  maxInteractionsPerDay: number;
}
