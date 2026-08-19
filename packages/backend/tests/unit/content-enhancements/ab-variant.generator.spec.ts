import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ABVariantGenerator } from '../../../src/modules/content-enhancements/ab-variant.generator';
import { SocialNetwork } from '@prisma/client';

describe('ABVariantGenerator', () => {
  it('returns null when disabled', async () => {
    const config = new ConfigService({ AB_VARIANTS_ENABLED: 'false' });
    const generator = new ABVariantGenerator(config);

    const result = await generator.generateVariants('base content', SocialNetwork.X);

    expect(result).toBeNull();
  });

  it('generates heuristic variants with clean/expressive split', async () => {
    const config = new ConfigService({ AB_VARIANTS_ENABLED: 'true' });
    const generator = new ABVariantGenerator(config);

    const result = await generator.generateVariants(
      'Workflow Trends starts next week. Pause before sending. Reflect on the past. #productivity',
      SocialNetwork.X,
    );

    expect(result).not.toBeNull();
    expect(result!.a.label).toBe('a');
    expect(result!.b.label).toBe('b');
    expect(result!.a.emojiCount).toBe(0);
    expect(result!.b.emojiCount).toBeGreaterThanOrEqual(2);
    expect(result!.a.hashtagCount).toBe(0);
    expect(result!.b.hashtagCount).toBe(0);
  });

  it('uses LLM and respects priorWinner=a', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: 'A: Clean variant\nB: Expressive variant',
        model: 'gpt-5-nano',
        tokens: 50,
        cost: 0.001,
      }),
    };
    const config = new ConfigService({ AB_VARIANTS_ENABLED: 'true' });
    const generator = new ABVariantGenerator(config, mockLlm as never);

    await generator.generateVariants('base content', SocialNetwork.X, { topic: 'Workflow', priorWinner: 'a' });

    expect(mockLlm.generateChat).toHaveBeenCalled();
    const systemPrompt = mockLlm.generateChat.mock.calls[0][0];
    expect(systemPrompt).toContain('Clean/Minimal" style');
    expect(systemPrompt).toContain('Prior winner');
  });

  it('uses LLM and respects priorWinner=b', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: 'A: Clean variant\nB: Expressive variant',
        model: 'gpt-5-nano',
        tokens: 50,
        cost: 0.001,
      }),
    };
    const config = new ConfigService({ AB_VARIANTS_ENABLED: 'true' });
    const generator = new ABVariantGenerator(config, mockLlm as never);

    await generator.generateVariants('base content', SocialNetwork.X, { topic: 'Workflow', priorWinner: 'b' });

    const systemPrompt = mockLlm.generateChat.mock.calls[0][0];
    expect(systemPrompt).toContain('Expressive/Rich" style');
  });

  it('falls back to heuristic when LLM fails', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockRejectedValue(new Error('LLM error')),
    };
    const config = new ConfigService({ AB_VARIANTS_ENABLED: 'true' });
    const generator = new ABVariantGenerator(config, mockLlm as never);

    const result = await generator.generateVariants('base content', SocialNetwork.X);

    expect(result).not.toBeNull();
    expect(result!.a.label).toBe('a');
    expect(result!.b.label).toBe('b');
  });
});
