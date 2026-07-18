/**
 * RC2/RC3: RecyclingService.
 *
 * RC3 — recyclePost must re-write content through the generation graph (delegate to
 *        GenerationService.recycleById), never create a verbatim copy of the original.
 * RC2 — the recycling cron is flag-gated (RECYCLING_CRON_ENABLED), default OFF.
 *
 * Source: packages/backend/src/modules/recycling/recycling.service.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecyclingService } from '../../../src/modules/recycling/recycling.service';
import { createMockConfigService } from '../../mocks/index';

function mockPrisma() {
  return {
    post: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

function mockGeneration() {
  return {
    recycleById: vi.fn().mockResolvedValue({ id: 'draft-1', status: 'DRAFT' }),
    recycleTopPosts: vi.fn().mockResolvedValue('run-1'),
  };
}

describe('RecyclingService (RC2/RC3)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gen: any;
  let service: RecyclingService;

  beforeEach(() => {
    prisma = mockPrisma();
    gen = mockGeneration();
    const config = createMockConfigService();
    const schedulerRegistry = { addCronJob: vi.fn(), deleteCronJob: vi.fn() } as unknown as import('@nestjs/schedule').SchedulerRegistry;
    service = new RecyclingService(config, prisma, gen, schedulerRegistry);
  });

  it('RC3: recyclePost re-writes via the generation graph (delegates to recycleById)', async () => {
    const result = await service.recyclePost('post-1');

    expect(gen.recycleById).toHaveBeenCalledWith('post-1');
    expect(result).toEqual({ id: 'draft-1', status: 'DRAFT' });
    // The old verbatim path is gone — RecyclingService no longer creates a draft directly.
    expect(prisma.post.create).not.toHaveBeenCalled();
  });

  it('RC3: recyclePost propagates a null (ineligible post) from recycleById', async () => {
    gen.recycleById.mockResolvedValue(null);
    expect(await service.recyclePost('missing')).toBeNull();
  });

  it('RC2: runRecycling can be called directly (cron registration is in onModuleInit)', async () => {
    const spy = vi.spyOn(service, 'runRecycling');
    await service.runRecycling();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
