/**
 * Language detection heuristic unit tests.
 *
 * Tests the script-based language detection used by:
 *   - RepliesMonitorService.detectLanguageHeuristic() (heuristic fallback for replies)
 *   - RepliesService.detectLanguage() (simple template fallback)
 *
 * The detection uses Cyrillic script analysis:
 *   - Ukrainian-specific chars: і, ї, є, ґ
 *   - Russian-specific chars: ы, э, ъ, ё
 *   - Word-level markers for ambiguous cases
 *   - Falls back to Ukrainian for ambiguous Cyrillic (brand is Ukraine-based)
 *
 * Source files:
 *   - packages/backend/src/modules/replies/replies-monitor.service.ts
 *   - packages/backend/src/modules/replies/replies.service.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RepliesMonitorService } from '../../../src/modules/replies/replies-monitor.service';
import { RepliesService } from '../../../src/modules/replies/replies.service';
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

function createMockAccountsService() {
  return {
    getAccount: vi.fn().mockResolvedValue(null),
  };
}

function createMockSessionsService() {
  return {
    getSession: vi.fn().mockResolvedValue(null),
  };
}

// ── RepliesMonitorService language detection ──

describe('RepliesMonitorService — Language Detection', () => {
  let service: RepliesMonitorService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;

  beforeEach(() => {
    service = new RepliesMonitorService(
      createMockPrismaService() as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
      createMockSessionsService() as any,
      createMockSchedulerRegistry() as any,
      createMockDiscord() as any,
      createMockSseService() as any,
      undefined, // llmService
      undefined, // browser
      undefined, // engagementService
    );
    svc = service;
  });

  // ── detectLanguageHeuristic ──

  it('LD-001: detects English for Latin-script text', () => {
    expect(svc.detectLanguageHeuristic('This is a great post about astrology')).toBe('en');
  });

  it('LD-002: detects English for short Latin text', () => {
    expect(svc.detectLanguageHeuristic('Love this!')).toBe('en');
  });

  it('LD-003: detects Ukrainian when і/ї/є chars present', () => {
    expect(svc.detectLanguageHeuristic('Це дуже цікавий пост про астрологію')).toBe('uk');
  });

  it('LD-004: detects Ukrainian with ї character', () => {
    expect(svc.detectLanguageHeuristic('Дякую за цей пост, дуже цікаві думки')).toBe('uk');
  });

  it('LD-005: detects Ukrainian with є character', () => {
    expect(svc.detectLanguageHeuristic('Це правда, зірки завжди знають краще')).toBe('uk');
  });

  it('LD-006: detects Russian when ы/э/ъ chars present', () => {
    expect(svc.detectLanguageHeuristic('Это очень интересный пост про астрологию, спасибо')).toBe('ru');
  });

  it('LD-007: detects Russian with ё character', () => {
    expect(svc.detectLanguageHeuristic('Спасибо за пост, очень интересно')).toBe('ru');
  });

  it('LD-008: detects Russian with ъ character', () => {
    expect(svc.detectLanguageHeuristic('Это объёмный вопрос, спасибо за объяснение')).toBe('ru');
  });

  it('LD-009: returns en for text with fewer than 3 Cyrillic chars', () => {
    // Mostly Latin with a stray Cyrillic char
    expect(svc.detectLanguageHeuristic('OK post a b')).toBe('en');
  });

  it('LD-010: defaults to Ukrainian for ambiguous Cyrillic (no specific chars)', () => {
    // Cyrillic text without і/ї/є/ґ or ы/э/ъ/ё — ambiguous
    // Uses common Cyrillic letters that could be either Ukrainian or Russian
    expect(svc.detectLanguageHeuristic('Це дуже гарний пост про зорі')).toBe('uk');
  });

  it('LD-011: uses word-level markers for ambiguous Cyrillic — Ukrainian words', () => {
    // Text with Ukrainian word markers but no specific chars
    expect(svc.detectLanguageHeuristic('Це правда, дуже цікаво, дякую')).toBe('uk');
  });

  it('LD-012: uses word-level markers for ambiguous Cyrillic — Russian words', () => {
    // Text with Russian word markers but no specific chars
    expect(svc.detectLanguageHeuristic('Это правда, очень интересно, спасибо')).toBe('ru');
  });

  it('LD-013: handles empty string', () => {
    expect(svc.detectLanguageHeuristic('')).toBe('en');
  });

  it('LD-014: handles text with only numbers and symbols', () => {
    expect(svc.detectLanguageHeuristic('12345 !!! ???')).toBe('en');
  });

  it('LD-015: handles mixed Latin+Cyrillic text (Cyrillic dominant)', () => {
    // Enough Cyrillic to trigger detection
    expect(svc.detectLanguageHeuristic('Дякую за пост! Very interesting take on Mars.')).toBe('uk');
  });

  it('LD-016: handles text with emoji', () => {
    expect(svc.detectLanguageHeuristic('Це дуже цікаво ✨🔮')).toBe('uk');
  });

  it('LD-017: detects Ukrainian for a typical Ukrainian comment', () => {
    const comment = 'Сатурн повернувся в 28 — повністю змінив моє бачення затримок';
    expect(svc.detectLanguageHeuristic(comment)).toBe('uk');
  });

  it('LD-018: detects Russian for a typical Russian comment', () => {
    const comment = 'Сатурн вернулся в 28 — полностью изменил моё видение задержек';
    expect(svc.detectLanguageHeuristic(comment)).toBe('ru');
  });

  it('LD-019: detects English for a typical English comment', () => {
    const comment = 'Saturn return hit me at 28 too — completely reframed how I see delays';
    expect(svc.detectLanguageHeuristic(comment)).toBe('en');
  });

  // ── getReplyTemplates ──

  it('LD-020: returns Ukrainian templates for uk', () => {
    const templates = svc.getReplyTemplates('uk');
    expect(templates.question).toContain('запитання');
    expect(templates.positive).toContain('Дякуємо');
    expect(templates.default).toContain('знак');
  });

  it('LD-021: returns Russian templates for ru', () => {
    const templates = svc.getReplyTemplates('ru');
    expect(templates.question).toContain('вопрос');
    expect(templates.positive).toContain('Спасибо');
    expect(templates.default).toContain('знак');
  });

  it('LD-022: returns English templates for en', () => {
    const templates = svc.getReplyTemplates('en');
    expect(templates.question).toContain('question');
    expect(templates.positive).toContain('Thank you');
    expect(templates.default).toContain("sign");
  });

  it('LD-023: templates are non-empty strings for all languages', () => {
    for (const lang of ['uk', 'ru', 'en']) {
      const templates = svc.getReplyTemplates(lang);
      expect(templates.question.length).toBeGreaterThan(10);
      expect(templates.positive.length).toBeGreaterThan(10);
      expect(templates.default.length).toBeGreaterThan(10);
    }
  });

  it('LD-024: Ukrainian templates contain ✨ emoji (brand voice)', () => {
    const templates = svc.getReplyTemplates('uk');
    expect(templates.question).toContain('✨');
    expect(templates.positive).toContain('✨');
    expect(templates.default).toContain('✨');
  });

  it('LD-025: Russian templates contain ✨ emoji (brand voice)', () => {
    const templates = svc.getReplyTemplates('ru');
    expect(templates.question).toContain('✨');
    expect(templates.positive).toContain('✨');
    expect(templates.default).toContain('✨');
  });

  // ── heuristicDecideReply — language-aware patterns ──

  it('LD-026: detects sensitive topics in Ukrainian (депресія)', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'У мене депресія через це' },
    );
    expect(result.action).toBe('human_review');
  });

  it('LD-026a: does NOT flag innocent words containing "гор" (город, гора)', () => {
    // "гор" was previously matched as grief, but it matches innocent words too
    const result1 = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Я живу в красивому місті' },
    );
    expect(result1.action).not.toBe('human_review');

    const result2 = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Це як гора — важко піднятися' },
    );
    expect(result2.action).not.toBe('human_review');
  });

  it('LD-026b: detects grief in Ukrainian (горе, горю)', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Яке горе, втратила близьку людину' },
    );
    expect(result.action).toBe('human_review');
  });

  it('LD-027: detects sensitive topics in Russian (кризис)', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'У меня кризис из-за этого' },
    );
    expect(result.action).toBe('human_review');
  });

  it('LD-028: detects complaints in Ukrainian (неправильно)', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Це неправильно, ви помиляєтесь' },
    );
    expect(result.action).toBe('human_review');
  });

  it('LD-029: detects questions in Ukrainian and replies in Ukrainian', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Як це працює?' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.replyText).toContain('запитання');
  });

  it('LD-030: detects questions in Russian and replies in Russian', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Как это работает?' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.replyText).toContain('вопрос');
  });

  it('LD-031: detects positive engagement in Ukrainian (дякую) and replies in Ukrainian', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Дякую за пост, дуже цікаво' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.replyText).toContain('Дякуємо');
  });

  it('LD-032: detects positive engagement in Russian (спасибо) and replies in Russian', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Спасибо за пост, очень интересно' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.replyText).toContain('Спасибо');
  });

  it('LD-033: default reply in English for English comment', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Just commenting here' },
    );
    expect(result.action).toBe('auto_reply');
    expect(result.replyText).toContain('sign');
  });

  it('LD-034: detects questions starting with Ukrainian question words (що)', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Що означає цей аспект?' },
    );
    expect(result.action).toBe('auto_reply');
  });

  it('LD-035: detects questions starting with Russian question words (что)', () => {
    const result = svc.heuristicDecideReply(
      { id: '1', network: 'X', content: 'Post about Mars' },
      { id: '2', commentId: 'c1', author: 'user', text: 'Что означает этот аспект?' },
    );
    expect(result.action).toBe('auto_reply');
  });
});

// ── RepliesService language detection ──

describe('RepliesService — Language Detection', () => {
  let service: RepliesService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;

  beforeEach(() => {
    service = new RepliesService(
      createMockPrismaService() as any,
      createMockConfigService({ REPLIES_ENABLED: 'true' }),
      createMockAccountsService() as any,
    );
    svc = service;
  });

  // ── detectLanguage ──

  it('LD-036: detects English for Latin text', () => {
    expect(svc.detectLanguage('Great post about astrology')).toBe('en');
  });

  it('LD-037: detects Ukrainian with і character', () => {
    expect(svc.detectLanguage('Це цікавий пост про астрологію')).toBe('uk');
  });

  it('LD-038: detects Russian with ы character', () => {
    expect(svc.detectLanguage('Это интересный пост про астрологию, спасибо')).toBe('ru');
  });

  it('LD-039: defaults to Ukrainian for ambiguous Cyrillic', () => {
    expect(svc.detectLanguage('Це правда, дуже цікаво')).toBe('uk');
  });

  it('LD-040: returns en for text with fewer than 3 Cyrillic chars', () => {
    expect(svc.detectLanguage('OK')).toBe('en');
  });

  it('LD-041: handles empty string', () => {
    expect(svc.detectLanguage('')).toBe('en');
  });

  // ── generateReplyText ──

  it('LD-042: generates Ukrainian reply for Ukrainian question', () => {
    const comment = { id: '1', author: 'user', text: 'Як це працює?', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, true);
    expect(reply).toContain('запитання');
  });

  it('LD-043: generates Russian reply for Russian question', () => {
    const comment = { id: '1', author: 'user', text: 'Как это работает?', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, true);
    expect(reply).toContain('вопрос');
  });

  it('LD-044: generates English reply for English question', () => {
    const comment = { id: '1', author: 'user', text: 'How does this work?', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, true);
    expect(reply).toContain('question');
  });

  it('LD-045: generates Ukrainian reply for Ukrainian positive comment', () => {
    const comment = { id: '1', author: 'user', text: 'Дякую за пост, дуже цікаво', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, false);
    expect(reply).toContain('Дякуємо');
  });

  it('LD-046: generates Russian reply for Russian positive comment', () => {
    const comment = { id: '1', author: 'user', text: 'Спасибо за пост, очень интересно', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, false);
    expect(reply).toContain('Спасибо');
  });

  it('LD-047: generates English reply for English positive comment', () => {
    const comment = { id: '1', author: 'user', text: 'Love this post, very interesting', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, false);
    expect(reply).toContain('Thank you');
  });

  it('LD-048: generates Ukrainian default reply for Ukrainian non-question non-positive comment', () => {
    const comment = { id: '1', author: 'user', text: 'Це просто коментар', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, false);
    expect(reply).toContain('знак');
  });

  it('LD-049: generates Russian default reply for Russian non-question non-positive comment', () => {
    const comment = { id: '1', author: 'user', text: 'Это просто комментарий', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, false);
    expect(reply).toContain('знак');
  });

  it('LD-050: generates English default reply for English non-question non-positive comment', () => {
    const comment = { id: '1', author: 'user', text: 'Just a comment here', timestamp: new Date() };
    const reply = svc.generateReplyText('Post about Mars', comment, false);
    expect(reply).toContain('sign');
  });

  it('LD-051: all generated replies contain ✨ emoji (brand voice)', () => {
    const cases = [
      { text: 'How does this work?', isQ: true, lang: 'en' },
      { text: 'Як це працює?', isQ: true, lang: 'uk' },
      { text: 'Как это работает?', isQ: true, lang: 'ru' },
      { text: 'Love this!', isQ: false, lang: 'en' },
      { text: 'Дякую!', isQ: false, lang: 'uk' },
      { text: 'Спасибо!', isQ: false, lang: 'ru' },
      { text: 'Just commenting', isQ: false, lang: 'en' },
      { text: 'Просто коментар', isQ: false, lang: 'uk' },
      { text: 'Просто комментарий', isQ: false, lang: 'ru' },
    ];
    for (const c of cases) {
      const comment = { id: '1', author: 'user', text: c.text, timestamp: new Date() };
      const reply = svc.generateReplyText('Post content', comment, c.isQ);
      expect(reply).toContain('✨');
    }
  });
});
