import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SocialAccount, SocialNetwork } from '@prisma/client';
import { WarmupService } from '../sessions/warmup.service.js';
import { parseBool } from '../../infrastructure/config/parse-bool.js';
import { isNetworkEnabled } from '../../domain/enabled-networks.js';

/**
 * Credentials reference — env var names, never actual secrets.
 */
export interface AccountCredentials {
  username: string;
  password: string;
  extra?: string;
  cookies?: string;
}

/**
 * Account selection options for round-robin/priority pick.
 */
export interface NextAccountOptions {
  /** Prefer this account if it is active. */
  preferredAccountId?: string;
  /** Rotation strategy (default: round-robin). */
  strategy?: 'round-robin' | 'priority';
}

/**
 * Accounts service — manages social account records.
 * Credentials are NEVER stored in DB — only credentialsRef (env var names).
 * On startup, seeds accounts from env config if they don't exist.
 *
 * F20: If SOCIAL_{NETWORK}_WARMUP=true is set for a new account, warm-up
 * mode is started on seed (browse-only → gradual ramp, reduces ban risk).
 */
@Injectable()
export class AccountsService implements OnModuleInit {
  private readonly logger = new Logger(AccountsService.name);

  // In-memory round-robin pointer per network. This keeps assignment simple
  // for a single process; a future phase can persist the pointer in Redis if
  // the app is scaled horizontally.
  private readonly rotationIndexes = new Map<SocialNetwork, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly warmupService?: WarmupService,
  ) {}

  /**
   * Minor-29: Seed accounts from env on module init (moved from CronService).
   * This is the right place — AccountsService owns account lifecycle.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.seedFromEnv();
      this.logger.log('Accounts seeded from env');
    } catch {
      this.logger.warn('Failed to seed accounts — continuing');
    }
  }

  /**
   * Seed accounts from env on application startup.
   * Creates accounts if they don't exist, does not update existing.
   * Supports indexed multi-account env vars:
   *   SOCIAL_THREADS_USERNAME_2=... SOCIAL_THREADS_PASSWORD_2=...
   * Un-suffixed vars map to index 1 for backward compatibility.
   * F20: If SOCIAL_{NETWORK}_WARMUP_{N}=true, starts warm-up for the new account.
   */
  async seedFromEnv(): Promise<void> {
    const networks = [SocialNetwork.X, SocialNetwork.THREADS, SocialNetwork.FACEBOOK];

    for (const network of networks) {
      if (!isNetworkEnabled(network)) {
        this.logger.debug(`Skipping seed for disabled network: ${network}`);
        continue;
      }

      let index = 1;
      while (true) {
        const usernameField = network === SocialNetwork.FACEBOOK ? 'EMAIL' : 'USERNAME';
        const usernameRef = this.resolveIndexedEnv(network, usernameField, index);

        // Stop when no username/email var is configured for this index.
        if (usernameRef.value === undefined || usernameRef.value.trim() === '') {
          break;
        }

        const passwordRef = this.resolveIndexedEnv(network, 'PASSWORD', index);
        const cookiesRef = this.resolveIndexedEnv(network, 'COOKIES', index);
        const pageSlugRef = network === SocialNetwork.FACEBOOK ? this.resolveIndexedEnv(network, 'PAGE_SLUG', index) : undefined;

        const username = usernameRef.value;
        const password = passwordRef.value ?? '';
        const cookies = cookiesRef.value;
        const pageSlug = pageSlugRef?.value ?? '';
        const displayName = this.getIndexedEnv(network, 'DISPLAY_NAME', index);
        const priorityRaw = this.getIndexedEnv(network, 'PRIORITY', index);
        const proxyUrl = this.getIndexedEnv(network, 'PROXY_URL', index);
        const fingerprintSeed = this.getIndexedEnv(network, 'FINGERPRINT_SEED', index);
        const active = parseBool(this.getIndexedEnv(network, 'ACTIVE', index) ?? 'true');
        const warmup = parseBool(this.getIndexedEnv(network, 'WARMUP', index) ?? 'false');
        const priority = Number.isNaN(Number(priorityRaw)) ? 0 : Number(priorityRaw);

        const handle = this.resolveHandle(network, username, pageSlug);

        const credentialsParts: string[] = [usernameRef.key, passwordRef.key];
        if (cookies !== undefined && cookies.trim() !== '') {
          credentialsParts.push(cookiesRef.key);
        }
        if (pageSlugRef && pageSlug.trim() !== '') {
          credentialsParts.push(pageSlugRef.key);
        }

        const existing = await this.prisma.socialAccount.findFirst({
          where: { network, handle },
        });

        if (!existing) {
          const created = await this.prisma.socialAccount.create({
            data: {
              network,
              handle,
              displayName,
              priority,
              proxyUrl,
              fingerprintSeed,
              credentialsRef: credentialsParts.join(','),
              active,
              warmupEnabled: warmup,
            },
          });
          this.logger.log(`Seeded account: ${network} @${handle}`);

          if (warmup && this.warmupService) {
            await this.warmupService.startWarmup(created.id);
            this.logger.log(`Warm-up started for ${network} @${handle}`);
          }
        } else {
          // Keep DB references aligned when credential env vars are renamed
          // (for example SOCIAL_X_USERNAME -> SOCIAL_X_USERNAME_1). Existing
          // accounts must be updated because credentialsRef intentionally stores
          // env var names, not their values.
          const credentialsRef = credentialsParts.join(',');
          if (existing.credentialsRef !== credentialsRef) {
            await this.prisma.socialAccount.update({
              where: { id: existing.id },
              data: { credentialsRef },
            });
            this.logger.log(`Updated credential references: ${network} @${handle}`);
          }
        }

        index++;
      }
    }
  }

  async findAll(network?: SocialNetwork) {
    return this.prisma.socialAccount.findMany({
      where: { active: true, ...(network ? { network } : {}) },
      include: { sessions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async findById(id: string): Promise<SocialAccount | null> {
    return this.prisma.socialAccount.findUnique({
      where: { id },
    });
  }

  /**
   * Find all active accounts for a network, sorted by priority DESC, createdAt ASC.
   */
  async findByNetwork(network: SocialNetwork): Promise<SocialAccount[]> {
    return this.prisma.socialAccount.findMany({
      where: { network, active: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Find the single active account that should be used when a caller needs exactly one.
   * Prefers the account whose handle matches the configured default env credentials,
   * then falls back to the highest-priority active account. This preserves backward
   * compatibility with the old single-account behaviour while multi-account is being rolled out.
   */
  async findFirstActiveByNetwork(network: SocialNetwork): Promise<SocialAccount | null> {
    const defaultUsername = this.getNetworkDefaultUsername(network);
    if (defaultUsername) {
      const matching = await this.prisma.socialAccount.findFirst({
        where: { network, active: true, handle: defaultUsername },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });
      if (matching) return matching;
    }

    return this.prisma.socialAccount.findFirst({
      where: { network, active: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Pick the next active account for a network.
   * - `priority` strategy: highest priority account (tie-break createdAt ASC).
   * - `round-robin` strategy (default): cycles through active accounts in priority order.
   * - `preferredAccountId`: if provided and active, returns that account.
   */
  async getNextAccountForNetwork(
    network: SocialNetwork,
    opts: NextAccountOptions = {},
  ): Promise<SocialAccount | null> {
    const accounts = await this.findByNetwork(network);
    if (accounts.length === 0) return null;

    if (opts.preferredAccountId) {
      const preferred = accounts.find((a) => a.id === opts.preferredAccountId);
      if (preferred) return preferred;
    }

    if (opts.strategy === 'priority') {
      return accounts[0] ?? null;
    }

    // Round-robin with in-memory pointer per network.
    const current = this.rotationIndexes.get(network) ?? 0;
    const next = accounts[current % accounts.length] ?? accounts[0];
    this.rotationIndexes.set(network, (current + 1) % accounts.length);
    return next ?? null;
  }

  /**
   * Get credentials from env (never from DB).
   * Parses the account's `credentialsRef` string (comma-separated env var names).
   */
  getCredentials(account: SocialAccount): AccountCredentials {
    const result: AccountCredentials = { username: '', password: '' };
    const refs = account.credentialsRef
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const ref of refs) {
      const value = this.configService.get<string>(ref, '');
      if (ref.includes('_PASSWORD')) {
        result.password = value;
      } else if (ref.includes('_COOKIES')) {
        result.cookies = value;
      } else if (ref.includes('_PAGE_SLUG')) {
        result.extra = value;
      } else if (ref.includes('_EMAIL') || ref.includes('_USERNAME')) {
        result.username = value;
      }
    }

    return result;
  }

  /**
   * Update non-credential account fields. Credentials remain env-driven.
   */
  async update(id: string, data: Partial<Pick<SocialAccount, 'displayName' | 'priority' | 'groupId' | 'proxyUrl' | 'fingerprintSeed' | 'active'>>): Promise<SocialAccount> {
    return this.prisma.socialAccount.update({
      where: { id },
      data: {
        ...(data.displayName !== undefined && { displayName: data.displayName }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.groupId !== undefined && { groupId: data.groupId }),
        ...(data.proxyUrl !== undefined && { proxyUrl: data.proxyUrl }),
        ...(data.fingerprintSeed !== undefined && { fingerprintSeed: data.fingerprintSeed }),
        ...(data.active !== undefined && { active: data.active }),
      },
    });
  }

  /**
   * Soft-delete an account by marking it inactive. Preserves history.
   */
  async deactivate(id: string): Promise<SocialAccount> {
    return this.prisma.socialAccount.update({
      where: { id },
      data: { active: false },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resolve an indexed env var. Always tries the `_N` suffixed key first; for index 1
   * falls back to the legacy un-suffixed key. Returns both the value and the key that
   * was actually used so `credentialsRef` can point to the correct env var name(s).
   */
  private resolveIndexedEnv(
    network: SocialNetwork,
    field: string,
    index: number,
  ): { value: string | undefined; key: string } {
    const networkName = network === SocialNetwork.X ? 'X' : network;
    const suffixedKey = `SOCIAL_${networkName}_${field}_${index}`;
    const suffixed = this.configService.get<string>(suffixedKey);
    if (suffixed !== undefined) {
      return { value: suffixed, key: suffixedKey };
    }

    if (index === 1) {
      const legacyKey = `SOCIAL_${networkName}_${field}`;
      const legacy = this.configService.get<string>(legacyKey);
      if (legacy !== undefined) {
        return { value: legacy, key: legacyKey };
      }
    }

    return { value: undefined, key: suffixedKey };
  }

  private getIndexedEnv(network: SocialNetwork, field: string, index: number): string | undefined {
    return this.resolveIndexedEnv(network, field, index).value;
  }

  private resolveHandle(network: SocialNetwork, username: string, pageSlug: string): string {
    if (network === SocialNetwork.FACEBOOK && pageSlug && pageSlug.trim() !== '') {
      return pageSlug.trim();
    }
    return username.trim();
  }

  private getNetworkDefaultUsername(network: SocialNetwork): string {
    const usernameField = network === SocialNetwork.FACEBOOK ? 'EMAIL' : 'USERNAME';
    return this.resolveIndexedEnv(network, usernameField, 1).value ?? '';
  }
}
