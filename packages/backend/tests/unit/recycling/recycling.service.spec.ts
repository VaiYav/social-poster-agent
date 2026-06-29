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
    service = new RecyclingService(prisma, gen);
  });

  afterEach(() => {
    delete process.env.RECYCLING_CRON_ENABLED;
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

  it('RC2 cron: skips when RECYCLING_CRON_ENABLED is not "true"', async () => {
    const spy = vi.spyOn(service, 'runRecycling');
    await service.recyclingCron();
    expect(spy).not.toHaveBeenCalled();
  });

  it('RC2 cron: runs recycling when explicitly enabled', async () => {
    process.env.RECYCLING_CRON_ENABLED = 'true';
    const spy = vi.spyOn(service, 'runRecycling');
    await service.recyclingCron();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
