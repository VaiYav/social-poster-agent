/**
 * F3: GenerationController model picker wiring tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GenerationController } from '../../../src/modules/generation/generation.controller.js';
import { GenerationTrigger } from '@prisma/client';

function createMockService() {
  return {
    generate: vi.fn().mockResolvedValue('run-001'),
    repurposeFromArticles: vi.fn().mockResolvedValue('run-002'),
    recycleTopPosts: vi.fn().mockResolvedValue('run-003'),
    listRuns: vi.fn().mockResolvedValue([]),
    getRun: vi.fn().mockResolvedValue(null),
    resumeRun: vi.fn().mockResolvedValue({ status: 'resumed' }),
    resumeWithReview: vi.fn().mockResolvedValue({ status: 'reviewed' }),
    pauseRun: vi.fn().mockResolvedValue({ status: 'paused' }),
    listCheckpoints: vi.fn().mockResolvedValue([]),
    getCheckpointState: vi.fn().mockResolvedValue({}),
  };
}

describe('F3 / GenerationController — model picker', () => {
  let controller: GenerationController;
  let service: ReturnType<typeof createMockService>;

  beforeEach(() => {
    service = createMockService();
    controller = new GenerationController(service as any);
  });

  it('F3-101: passes model override to GenerationService.generate', async () => {
    const body = {
      count: 3,
      networks: ['X', 'THREADS'],
      sourceType: 'brief',
      multiStage: false,
      model: 'openai/gpt-5-nano',
    };

    const res = await controller.run(body);

    expect(service.generate).toHaveBeenCalledWith(
      3,
      ['X', 'THREADS'],
      GenerationTrigger.MANUAL,
      false,
      false,
      'openai/gpt-5-nano',
    );
    expect(res).toEqual({ runId: 'run-001', status: 'started' });
  });

  it('F3-102: omits model override when not provided', async () => {
    const body = {
      count: 1,
      networks: ['X'],
      sourceType: 'topic',
      multiStage: false,
    };

    await controller.run(body);

    expect(service.generate).toHaveBeenCalledWith(
      1,
      ['X'],
      GenerationTrigger.MANUAL,
      false,
      false,
      undefined,
    );
  });
});
