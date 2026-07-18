/**
 * TopicGenerationService unit tests.
 *
 * Traces to: Phase 5.11 — bulk topic insert with Prisma createMany + skipDuplicates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopicGenerationService } from '../../../src/infrastructure/content/topic-generation.service';
import { createMockConfigService } from '../../mocks/index';

function createMockPrisma() {
  return {
    topic: {
      count: vi.fn().mockResolvedValue(0),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function createMockLlm(response: string) {
  return {
    generateChat: vi.fn().mockResolvedValue({ content: response, model: 'gpt-4o-mini' }),
  };
}

describe('TopicGenerationService', () => {
  let service: TopicGenerationService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let llm: ReturnType<typeof createMockLlm>;

  beforeEach(() => {
    prisma = createMockPrisma();
    const response = JSON.stringify([
      { topic: 'Mercury Retrograde July 2026', keywords: ['mercury', 'retrograde'], facts: ['Starts July 14'], category: 'retrograde' },
      { topic: 'Full Moon in Capricorn', keywords: ['moon', 'capricorn'], facts: ['July 21'], category: 'lunar' },
      { topic: 'Mercury Retrograde July 2026', keywords: ['dup'], facts: ['dup'], category: 'retrograde' },
    ]);
    llm = createMockLlm(response);
    service = new TopicGenerationService(
      prisma as any,
      createMockConfigService() as any,
      { addCronJob: vi.fn() } as any,
      llm as any,
    );
  });

  it('TG-001: generateBatch uses createMany with skipDuplicates and in-memory dedup', async () => {
    prisma.topic.createMany.mockResolvedValue({ count: 2 });

    const count = await service.generateBatch(3);

    expect(count).toBe(2);
    expect(prisma.topic.createMany).toHaveBeenCalledTimes(1);
    const [callArg] = prisma.topic.createMany.mock.calls[0] as [{ data: unknown[]; skipDuplicates: boolean }];
    expect(callArg.skipDuplicates).toBe(true);
    expect(callArg.data).toHaveLength(2);
    const topics = callArg.data.map((d: any) => d.topic);
    expect(topics).toContain('Mercury Retrograde July 2026');
    expect(topics).toContain('Full Moon in Capricorn');
    // The duplicate topic string was removed in-memory.
    expect(new Set(topics).size).toBe(2);
  });
});
