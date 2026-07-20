import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { SocialNetwork } from '@prisma/client';
import { AccountsService } from '../../../src/modules/accounts/accounts.service';
import { createMockPrismaService } from '../../mocks/index';

function createMockConfigService(values: Record<string, string | undefined> = {}): ConfigService {
  return {
    get: vi.fn((key: string, def?: unknown) => {
      if (key in values) return values[key];
      return def;
    }),
  } as unknown as ConfigService;
}

describe('AccountsService', () => {
  let service: AccountsService;
  let prisma: ReturnType<typeof createMockPrismaService>;

  beforeEach(() => {
    prisma = createMockPrismaService() as any;
    service = new AccountsService(prisma as any, createMockConfigService(), undefined);
  });

  describe('seedFromEnv', () => {
    it('seeds a single account from legacy un-suffixed env vars', async () => {
      const config = createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret',
      });
      const svc = new AccountsService(prisma as any, config, undefined);

      prisma.socialAccount.findFirst.mockResolvedValue(null);
      prisma.socialAccount.create.mockResolvedValue({ id: 'acc-1' });

      await svc.seedFromEnv();

      expect(prisma.socialAccount.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          network: SocialNetwork.X,
          handle: 'myzodiacai',
          credentialsRef: 'SOCIAL_X_USERNAME,SOCIAL_X_PASSWORD',
          active: true,
        }),
      });
    });

    it('seeds multiple indexed accounts per network', async () => {
      const config = createMockConfigService({
        SOCIAL_THREADS_USERNAME_1: 'main',
        SOCIAL_THREADS_PASSWORD_1: 'p1',
        SOCIAL_THREADS_USERNAME_2: 'uk',
        SOCIAL_THREADS_PASSWORD_2: 'p2',
        SOCIAL_THREADS_DISPLAY_NAME_2: 'UK',
        SOCIAL_THREADS_PRIORITY_2: '5',
      });
      const svc = new AccountsService(prisma as any, config, undefined);

      prisma.socialAccount.findFirst.mockResolvedValue(null);
      prisma.socialAccount.create.mockResolvedValue({ id: 'acc-id' });

      await svc.seedFromEnv();

      expect(prisma.socialAccount.create).toHaveBeenCalledTimes(2);
      expect(prisma.socialAccount.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          network: SocialNetwork.THREADS,
          handle: 'uk',
          displayName: 'UK',
          priority: 5,
          credentialsRef: 'SOCIAL_THREADS_USERNAME_2,SOCIAL_THREADS_PASSWORD_2',
        }),
      });
    });

    it('stops seeding when no more usernames are configured', async () => {
      const config = createMockConfigService({
        SOCIAL_X_USERNAME_1: 'one',
        SOCIAL_X_PASSWORD_1: 'p1',
        SOCIAL_X_USERNAME_2: '',
      });
      const svc = new AccountsService(prisma as any, config, undefined);

      prisma.socialAccount.findFirst.mockResolvedValue(null);
      prisma.socialAccount.create.mockResolvedValue({ id: 'acc' });

      await svc.seedFromEnv();

      expect(prisma.socialAccount.create).toHaveBeenCalledTimes(1);
    });

    it('does not update existing accounts', async () => {
      const config = createMockConfigService({
        SOCIAL_X_USERNAME: 'myzodiacai',
        SOCIAL_X_PASSWORD: 'secret',
      });
      const svc = new AccountsService(prisma as any, config, undefined);

      prisma.socialAccount.findFirst.mockResolvedValue({ id: 'existing' });

      await svc.seedFromEnv();

      expect(prisma.socialAccount.create).not.toHaveBeenCalled();
    });
  });

  describe('getCredentials', () => {
    it('parses credentialsRef into username, password, extra and cookies', () => {
      const account = {
        credentialsRef: 'SOCIAL_FACEBOOK_EMAIL,SOCIAL_FACEBOOK_PASSWORD,SOCIAL_FACEBOOK_PAGE_SLUG,SOCIAL_FACEBOOK_COOKIES',
      } as any;
      const config = createMockConfigService({
        SOCIAL_FACEBOOK_EMAIL: 'fb@test.com',
        SOCIAL_FACEBOOK_PASSWORD: 'secret',
        SOCIAL_FACEBOOK_PAGE_SLUG: 'myzodiacai',
        SOCIAL_FACEBOOK_COOKIES: 'sessionid=abc',
      });
      const svc = new AccountsService(prisma as any, config, undefined);

      const creds = svc.getCredentials(account);
      expect(creds).toEqual({
        username: 'fb@test.com',
        password: 'secret',
        extra: 'myzodiacai',
        cookies: 'sessionid=abc',
      });
    });
  });

  describe('getNextAccountForNetwork', () => {
    it('round-robins active accounts in priority order', async () => {
      const accounts = [
        { id: 'a', network: SocialNetwork.X, handle: 'a', priority: 10, active: true },
        { id: 'b', network: SocialNetwork.X, handle: 'b', priority: 5, active: true },
      ];
      prisma.socialAccount.findMany.mockResolvedValue(accounts);

      const first = await service.getNextAccountForNetwork(SocialNetwork.X);
      const second = await service.getNextAccountForNetwork(SocialNetwork.X);
      const third = await service.getNextAccountForNetwork(SocialNetwork.X);

      expect(first?.id).toBe('a');
      expect(second?.id).toBe('b');
      expect(third?.id).toBe('a');
    });

    it('honours preferredAccountId when active', async () => {
      const accounts = [
        { id: 'a', network: SocialNetwork.X, handle: 'a', priority: 10, active: true },
        { id: 'b', network: SocialNetwork.X, handle: 'b', priority: 5, active: true },
      ];
      prisma.socialAccount.findMany.mockResolvedValue(accounts);

      const account = await service.getNextAccountForNetwork(SocialNetwork.X, { preferredAccountId: 'b' });
      expect(account?.id).toBe('b');
    });

    it('returns highest priority account in priority strategy', async () => {
      const accounts = [
        { id: 'a', network: SocialNetwork.X, handle: 'a', priority: 10, active: true },
        { id: 'b', network: SocialNetwork.X, handle: 'b', priority: 5, active: true },
      ];
      prisma.socialAccount.findMany.mockResolvedValue(accounts);

      const account = await service.getNextAccountForNetwork(SocialNetwork.X, { strategy: 'priority' });
      expect(account?.id).toBe('a');
    });
  });

  describe('findFirstActiveByNetwork', () => {
    it('prefers account matching default env username then falls back to priority', async () => {
      const config = createMockConfigService({ SOCIAL_X_USERNAME: 'primary' });
      const svc = new AccountsService(prisma as any, config, undefined);

      prisma.socialAccount.findFirst.mockResolvedValueOnce({ id: 'primary-acc' });

      const account = await svc.findFirstActiveByNetwork(SocialNetwork.X);

      expect(account?.id).toBe('primary-acc');
      expect(prisma.socialAccount.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { network: SocialNetwork.X, active: true, handle: 'primary' },
        }),
      );
    });
  });
});
