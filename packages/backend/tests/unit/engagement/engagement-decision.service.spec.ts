/**
 * EngagementDecisionService unit tests.
 *
 * Tests LLM-driven decision making and comment generation,
 * including budget enforcement and fallback behavior.
 *
 * Source: packages/backend/src/modules/engagement/engagement-decision.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngagementDecisionService } from '../../../src/modules/engagement/engagement-decision.service';
import type { ILlmPort, LlmResponse } from '../../../src/domain/ports/llm.port';
import type { PostContext } from '../../../src/domain/ports/engagement-decision.port';

function createMockLlm(responses: Partial<LlmResponse>[] = []): ILlmPort {
  let callIndex = 0;
  return {
    generate: vi.fn(async (): Promise<LlmResponse> => {
      const resp = responses[callIndex] ?? { content: '{"action":"scroll","reason":"test","confidence":0.5}', model: 'mock' };
      callIndex++;
      return resp as LlmResponse;
    }),
    generateChat: vi.fn(async (_system: string, _user: string): Promise<LlmResponse> => {
      const resp = responses[callIndex] ?? { content: '{"action":"scroll","reason":"test","confidence":0.5}', model: 'mock' };
      callIndex++;
      return resp as LlmResponse;
    }),
    getPromptVersion: vi.fn(() => 'test'),
  };
}

function createPostContext(overrides: Partial<PostContext> = {}): PostContext {
  return {
    network: 'X',
    postUrl: 'https://x.com/user/status/123',
    postText: 'Mars in Aries brings energy and initiative today.',
    hasMedia: false,
    source: 'home-feed',
    likesThisSession: 0,
    commentsThisSession: 0,
    likesMaxPerSession: 15,
    commentsMaxPerSession: 4,
    ...overrides,
  };
}

describe('EngagementDecisionService', () => {
  let service: EngagementDecisionService;
  let mockLlm: ILlmPort;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── decideAction ──

  it('ED-001: parses valid JSON decision from LLM', async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"like","reason":"relevant to astrology","confidence":0.8}', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe('like');
    expect(decision.reason).toBe('relevant to astrology');
    expect(decision.confidence).toBe(0.8);
  });

  it('ED-002: falls back to scroll when LLM returns invalid JSON', async () => {
    mockLlm = createMockLlm([{ content: 'not json at all', model: 'mock' }]);
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe('scroll');
    expect(decision.confidence).toBeLessThan(0.5);
  });

  it('ED-003: falls back to scroll when LLM returns invalid action', async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"invalid_action","reason":"test","confidence":0.5}', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe('scroll');
  });

  it('ED-004: downgrades like to read when like budget exhausted', async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"like","reason":"good post","confidence":0.9}', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext({
      likesThisSession: 15,
      likesMaxPerSession: 15,
    }));
    expect(decision.action).toBe('read');
  });

  it('ED-005: downgrades comment to read when comment budget exhausted', async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"comment","reason":"great discussion","confidence":0.9,"commentText":"test"}', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext({
      commentsThisSession: 4,
      commentsMaxPerSession: 4,
    }));
    expect(decision.action).toBe('read');
  });

  it('ED-006: generates comment text when LLM decides comment but provides none', async () => {
    mockLlm = createMockLlm([
      { content: '{"action":"comment","reason":"relevant","confidence":0.8}', model: 'mock' },
      { content: 'Saturn return hit me too — completely reframed how I see delays.', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe('comment');
    expect(decision.commentText).toBeDefined();
    expect(decision.commentText!.length).toBeGreaterThan(0);
  });

  it('ED-007: uses fallback decision when LLM is null', async () => {
    service = new EngagementDecisionService(null as never);

    const decision = await service.decideAction(createPostContext());
    // Fallback should return a valid action
    expect(['scroll', 'read', 'like', 'comment']).toContain(decision.action);
    expect(decision.confidence).toBeLessThan(0.5);
  });

  it('ED-008: uses fallback decision when LLM throws', async () => {
    mockLlm = {
      generate: vi.fn().mockRejectedValue(new Error('API down')),
      generateChat: vi.fn().mockRejectedValue(new Error('API down')),
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext());
    expect(['scroll', 'read', 'like', 'comment']).toContain(decision.action);
  });

  it('ED-009: handles markdown-wrapped JSON from LLM', async () => {
    mockLlm = createMockLlm([
      { content: '```json\n{"action":"read","reason":"interesting","confidence":0.7}\n```', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const decision = await service.decideAction(createPostContext());
    expect(decision.action).toBe('read');
    expect(decision.confidence).toBe(0.7);
  });

  // ── generateComment ──

  it('ED-010: generates comment from LLM', async () => {
    mockLlm = createMockLlm([
      { content: 'The Moon in Cancer energy is so real this week.', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const comment = await service.generateComment(createPostContext());
    expect(comment).toBe('The Moon in Cancer energy is so real this week.');
  });

  it('ED-011: rejects forbidden comments (self-promo)', async () => {
    mockLlm = createMockLlm([
      { content: 'Check out myzodiacai.com for your chart!', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const comment = await service.generateComment(createPostContext());
    // Should fall back since the comment contains self-promo
    expect(comment).not.toContain('myzodiacai.com');
  });

  it('ED-012: rejects forbidden comments (generic phrases)', async () => {
    mockLlm = createMockLlm([
      { content: 'Great post! Thanks for sharing.', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const comment = await service.generateComment(createPostContext());
    expect(comment).not.toContain('Great post');
  });

  it('ED-013: rejects forbidden comments (links)', async () => {
    mockLlm = createMockLlm([
      { content: 'Interesting! https://bit.ly/something', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const comment = await service.generateComment(createPostContext());
    expect(comment).not.toContain('bit.ly');
  });

  it('ED-014: uses fallback comment when LLM is null', async () => {
    service = new EngagementDecisionService(null as never);

    const comment = await service.generateComment(createPostContext());
    expect(comment.length).toBeGreaterThan(0);
  });

  it('ED-015: uses fallback comment when LLM throws', async () => {
    mockLlm = {
      generate: vi.fn().mockRejectedValue(new Error('API down')),
      generateChat: vi.fn().mockRejectedValue(new Error('API down')),
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm);

    const comment = await service.generateComment(createPostContext());
    expect(comment.length).toBeGreaterThan(0);
  });

  // ── decideActionsBatch ──

  it('ED-016: batch decision returns one decision per context', async () => {
    mockLlm = createMockLlm([
      { content: '[{"action":"like","reason":"good","confidence":0.9},{"action":"scroll","reason":"boring","confidence":0.6}]', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const contexts = [createPostContext(), createPostContext({ postText: 'Off-topic post' })];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.action).toBe('like');
    expect(decisions[1]!.action).toBe('scroll');
  });

  it('ED-017: batch decision makes single LLM call', async () => {
    mockLlm = createMockLlm([
      { content: '[{"action":"scroll","reason":"test","confidence":0.5},{"action":"scroll","reason":"test","confidence":0.5}]', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const contexts = [createPostContext(), createPostContext()];
    await service.decideActionsBatch!(contexts);
    expect(mockLlm.generateChat).toHaveBeenCalledTimes(1);
  });

  it('ED-018: batch decision enforces like budget per-post', async () => {
    mockLlm = createMockLlm([
      { content: '[{"action":"like","reason":"good","confidence":0.9},{"action":"like","reason":"good","confidence":0.9}]', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const contexts = [
      createPostContext({ likesThisSession: 15, likesMaxPerSession: 15 }),
      createPostContext({ likesThisSession: 15, likesMaxPerSession: 15 }),
    ];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions[0]!.action).toBe('read'); // budget exhausted → downgraded
    expect(decisions[1]!.action).toBe('read');
  });

  it('ED-019: batch decision enforces comment budget per-post', async () => {
    mockLlm = createMockLlm([
      { content: '[{"action":"comment","reason":"good","confidence":0.9,"commentText":"test"}]', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const contexts = [createPostContext({ commentsThisSession: 4, commentsMaxPerSession: 4 })];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions[0]!.action).toBe('read'); // budget exhausted → downgraded
  });

  it('ED-020: batch decision falls back to individual calls on LLM failure', async () => {
    mockLlm = {
      generate: vi.fn().mockRejectedValue(new Error('API down')),
      generateChat: vi.fn()
        .mockRejectedValueOnce(new Error('API down')) // batch call fails
        .mockResolvedValueOnce({ content: '{"action":"scroll","reason":"fallback","confidence":0.4}', model: 'mock' }) // individual call 1
        .mockResolvedValueOnce({ content: '{"action":"scroll","reason":"fallback","confidence":0.4}', model: 'mock' }), // individual call 2
      getPromptVersion: vi.fn(),
    } as unknown as ILlmPort;
    service = new EngagementDecisionService(mockLlm);

    const contexts = [createPostContext(), createPostContext()];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!.action).toBe('scroll');
    expect(decisions[1]!.action).toBe('scroll');
  });

  it('ED-021: batch decision uses fallback when LLM is null', async () => {
    service = new EngagementDecisionService(null as never);

    const contexts = [createPostContext(), createPostContext()];
    const decisions = await service.decideActionsBatch!(contexts);
    expect(decisions).toHaveLength(2);
    for (const d of decisions) {
      expect(['scroll', 'read', 'like', 'comment']).toContain(d.action);
      expect(d.confidence).toBeLessThan(0.5);
    }
  });

  it('ED-022: batch decision handles empty context array', async () => {
    mockLlm = createMockLlm();
    service = new EngagementDecisionService(mockLlm);

    const decisions = await service.decideActionsBatch!([]);
    expect(decisions).toEqual([]);
    expect(mockLlm.generateChat).not.toHaveBeenCalled();
  });

  it('ED-023: batch decision parses markdown-wrapped JSON array', async () => {
    mockLlm = createMockLlm([
      { content: '```json\n[{"action":"read","reason":"interesting","confidence":0.7}]\n```', model: 'mock' },
    ]);
    service = new EngagementDecisionService(mockLlm);

    const decisions = await service.decideActionsBatch!([createPostContext()]);
    expect(decisions[0]!.action).toBe('read');
    expect(decisions[0]!.confidence).toBe(0.7);
  });
});
