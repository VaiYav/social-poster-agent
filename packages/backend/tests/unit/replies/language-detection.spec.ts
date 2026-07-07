/**
 * Replies monitor service unit tests.
 *
 * After RP5: ALL reply content is LLM-generated — no template fallback.
 * These tests cover the deterministic pre-LLM checks (troll, self-reply,
 * sensitive topic, max replies) that run before the LLM is called.
 *
 * Source: packages/backend/src/modules/replies/replies-monitor.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RepliesMonitorService } from '../../../src/modules/replies/replies-monitor.service';
import { createMockPrismaService } from '../../mocks/index';

// ── Mock dependencies ──

function createMockConfigService(values: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn((key: string, def?: unknown) => {
      if (key in values) return values[key];
      return def;
    }),
  } as unknown as ConfigService;
}

function createMockSchedulerRegistry() {
  return {
    addCronJob: vi.fn(),
    deleteCronJob: vi.fn(),
    getCronJobs: vi.fn().mockReturnValue(new Map()),
  };
}

function createMockDiscord() {
  return {
    notifyCritical: vi.fn().mockResolvedValue(undefined),
    notifyWarning: vi.fn().mockResolvedValue(undefined),
    notifyInfo: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSseService() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAccountsService(handle?: string) {
  return {
    findByNetwork: vi.fn().mockResolvedValue(handle ? { handle } : null),
    getAccount: vi.fn().mockResolvedValue(null),
  };
}

function createMockSessionsService() {
  return {
    getSession: vi.fn().mockResolvedValue(null),
  };
}

// ── RepliesMonitorService — deterministic pre-LLM checks ──

describe('RepliesMonitorService — Pre-LLM Decision Logic', () => {
  let service: RepliesMonitorService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;
  let prisma: any;

  beforeEach(() => {
    prisma = createMockPrismaService();
    // Add incomingComment model mock (not in the default mock factory)
    prisma.incomingComment = {
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    };

    service = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      undefined, // llmService — not wired, tests pre-LLM logic
      undefined, // browser
      undefined, // engagementService
    );
    svc = service;
  });

  // ── Troll/spam detection ──

  it('PRE-001: skips troll/spam comments', async () => {
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'This is spam, buy my product' },
    );
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('troll');
  });

  it('PRE-002: does NOT flag innocent words containing "bot" (about)', async () => {
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Tell me about this post' },
    );
    // "about" contains "bot" but should not be flagged as troll.
    // Without LLM wired, action will be 'skip' (LLM not available) — but the
    // reason should NOT mention troll/spam.
    expect(result.reason).not.toContain('troll');
    expect(result.reason).not.toContain('spam');
  });

  // ── Self-reply detection ──

  it('PRE-003: skips self-reply when comment author matches account handle', async () => {
    const svcWithHandle = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService('myzodiacai') as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      undefined, undefined, undefined,
    );
    const result = await (svcWithHandle as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: '@myzodiacai', text: 'Great post' },
    );
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('Self-reply');
  });

  // ── Max replies per post ──

  it('PRE-004: skips when max replies per post is reached', async () => {
    prisma.incomingComment.count = vi.fn().mockResolvedValue(3); // maxRepliesPerPost=3
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Great post about astrology' },
    );
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('Max replies');
  });

  // ── Sensitive topic detection (runs BEFORE LLM) ──

  it('PRE-005: flags depression mentions for human review (Ukrainian)', async () => {
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'У мене депресія через це' },
    );
    expect(result.action).toBe('human_review');
  });

  it('PRE-006: flags crisis mentions for human review (Russian)', async () => {
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'У меня кризис из-за этого' },
    );
    expect(result.action).toBe('human_review');
  });

  it('PRE-007: flags complaints for human review (Ukrainian)', async () => {
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Це неправильно, ви помиляєтесь' },
    );
    expect(result.action).toBe('human_review');
  });

  it('PRE-008: does NOT flag innocent words containing "гор" (город, гора)', async () => {
    const result1 = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Я живу в красивому місті' },
    );
    expect(result1.action).not.toBe('human_review');

    const result2 = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Це як гора — важко піднятися' },
    );
    expect(result2.action).not.toBe('human_review');
  });

  it('PRE-009: flags grief in Ukrainian (горе, горю)', async () => {
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Яке горе, втратила близьку людину' },
    );
    expect(result.action).toBe('human_review');
  });

  // ── LLM-only behavior ──

  it('PRE-010: skips with "LLM not available" when llmService is not wired', async () => {
    const result = await svc.decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Great post about astrology' },
    );
    // No LLM service → skip (no template fallback)
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('LLM');
  });

  it('PRE-011: calls LLM when service is wired', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","replyText":"Thanks! ✨"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      mockLlm as any,
      undefined, undefined,
    );
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post!' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.replyText).toContain('Thanks');
    expect(mockLlm.generateChat).toHaveBeenCalledOnce();
  });

  it('PRE-012: skips when LLM throws (all providers failed)', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockRejectedValue(new Error('All LLM providers failed')),
    };
    const svcWithLlm = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      mockLlm as any,
      undefined, undefined,
    );
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post!' },
    );
    // LLM failed → skip (no template fallback, will retry next cycle)
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('LLM unavailable');
  });

  it('PRE-013: skips when LLM returns no JSON', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: 'Sorry, I cannot help with that.',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      mockLlm as any,
      undefined, undefined,
    );
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post!' },
    );
    expect(result.action).toBe('skip');
    expect(result.reason).toContain('no JSON');
  });

  it('PRE-014: defaults to human_review when LLM returns invalid action', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"maybe","reason":"unsure"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      mockLlm as any,
      undefined, undefined,
    );
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post!' },
    );
    expect(result.action).toBe('human_review');
  });

  it('PRE-015: defaults to human_review when auto_reply has no replyText', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      mockLlm as any,
      undefined, undefined,
    );
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post!' },
    );
    expect(result.action).toBe('human_review');
  });

  // ── Config ──

  it('PRE-016: isEnabled returns true when REPLIES_ENABLED=true', () => {
    expect(service.isEnabled()).toBe(true);
  });

  it('PRE-017: isEnabled returns false when REPLIES_ENABLED=false', () => {
    const disabled = new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'false' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      undefined, undefined, undefined,
    );
    expect(disabled.isEnabled()).toBe(false);
  });

  // ── Language matching (post-validation) ──
  // The LLM is asked to detect the comment's language and write the reply in it.
  // We post-validate: if the LLM says "uk" but writes in Latin script, downgrade
  // to human_review instead of posting an English reply to a Ukrainian comment.

  function createServiceWithLlm(mockLlm: any) {
    return new RepliesMonitorService(
      prisma as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      mockLlm as any,
      undefined, undefined,
    );
  }

  it('LANG-001: accepts auto_reply when Ukrainian comment gets Ukrainian reply', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"uk","replyText":"Дякую! Це реально так."}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Це супер! Дякую' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.detectedLanguage).toBe('uk');
    expect(result.replyText).toContain('Дякую');
  });

  it('LANG-002: downgrades to human_review when LLM writes English reply to Ukrainian comment', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"uk","replyText":"Thanks for sharing this!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Це супер! Дякую' },
    );
    // Script mismatch: uk expected Cyrillic, got Latin → downgrade
    expect(result.action).toBe('human_review');
    expect(result.reviewReason).toContain('script');
  });

  it('LANG-003: downgrades to human_review when LLM writes English reply to Russian comment', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"ru","replyText":"Love this post!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Спасибо за пост' },
    );
    expect(result.action).toBe('human_review');
    expect(result.reviewReason).toContain('script');
  });

  it('LANG-004: accepts auto_reply when English comment gets English reply', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"en","replyText":"Thanks for the insight!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post about astrology' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.detectedLanguage).toBe('en');
  });

  it('LANG-005: accepts auto_reply when Spanish comment gets Spanish reply', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"es","replyText":"¡Gracias! Saturno es real."}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: '¡Me encanta este post!' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.detectedLanguage).toBe('es');
  });

  it('LANG-006: accepts auto_reply when Italian comment gets Italian reply', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"it","replyText":"Grazie! Saturno è reale."}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Mi piace questo post!' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.detectedLanguage).toBe('it');
  });

  it('LANG-007: downgrades when LLM writes Cyrillic reply to English comment', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"en","replyText":"Спасибо за пост"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post about astrology' },
    );
    // Script mismatch: en expected Latin, got Cyrillic → downgrade
    expect(result.action).toBe('human_review');
    expect(result.reviewReason).toContain('script');
  });

  it('LANG-008: accepts auto_reply when detectedLanguage is missing (no validation)', async () => {
    // Backward compat: if LLM doesn't return detectedLanguage, skip validation
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","replyText":"Thanks!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Love this post' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.replyText).toBe('Thanks!');
  });

  it('LANG-009: system prompt includes detectedLanguage in JSON schema', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"ok","detectedLanguage":"en","replyText":"Thanks!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Nice post' },
    );
    const [systemPrompt] = mockLlm.generateChat.mock.calls[0];
    expect(systemPrompt).toContain('detectedLanguage');
    expect(systemPrompt).toContain('en|ru|uk|es|it');
    expect(systemPrompt).toContain('LANGUAGE DETECTION');
  });

  it('LANG-010: accepts mixed-script reply for uk when Cyrillic dominates', async () => {
    // Ukrainian reply with English astrology term — Cyrillic dominates
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"uk","replyText":"Меркурий retrograde — це реально так."}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Так, це правда' },
    );
    expect(result.action).toBe('auto_reply');
  });

  it('LANG-011: accepts locale variant detectedLanguage (uk-UA normalizes to uk)', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"uk-UA","replyText":"Дякую за пост!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Дякую' },
    );
    expect(result.action).toBe('auto_reply');
  });

  it('LANG-013: trusts deterministic detector when LLM echoes a different language code', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"en","replyText":"Дякую за пост!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Дякую за пост' },
    );
    // Detector says uk, LLM said en; we validate the Cyrillic reply as uk → passes
    expect(result.action).toBe('auto_reply');
    expect(result.detectedLanguage).toBe('uk');
    expect(result.replyText).toContain('Дякую');
  });

  it('LANG-012: downgrades when locale variant detectedLanguage mismatches script', async () => {
    const mockLlm = {
      generateChat: vi.fn().mockResolvedValue({
        content: '{"action":"auto_reply","reason":"Positive","detectedLanguage":"ru-RU","replyText":"Thanks!"}',
        model: 'test',
        tokens: 10,
      }),
    };
    const svcWithLlm = createServiceWithLlm(mockLlm);
    const result = await (svcWithLlm as any).decideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Спасибо' },
    );
    // ru-RU normalizes to ru, but replyText is Latin → mismatch → human_review
    expect(result.action).toBe('human_review');
    expect(result.reviewReason).toContain('script');
  });
});
