/**
 * RP2: buildCommentId() unit tests.
 *
 * Guards against the Cyrillic/emoji collision bug where the old
 * `${author}-${text.slice(0,50)}`.replace(/[^a-zA-Z0-9]/g,'') approach collapsed
 * distinct non-Latin comments into one id, silently dropping real comments.
 *
 * Source: packages/backend/src/modules/replies/comment-id.ts
 */
import { describe, it, expect } from 'vitest';

import { buildCommentId } from '../../../src/modules/replies/comment-id';

describe('buildCommentId (RP2 — script-safe comment ids)', () => {
  it('is deterministic for the same author + text', () => {
    expect(buildCommentId('Олег', 'Спасибо за гороскоп!')).toBe(
      buildCommentId('Олег', 'Спасибо за гороскоп!'),
    );
  });

  it('distinguishes different Cyrillic comments by the SAME author (the core bug)', () => {
    const a = buildCommentId('Олег', 'Спасибо за гороскоп!');
    const b = buildCommentId('Олег', 'А когда ретроградный Меркурий?');
    expect(a).not.toBe(b);
  });

  it('distinguishes emoji-only comments by the same author', () => {
    const a = buildCommentId('Анна', '✨🔮');
    const b = buildCommentId('Анна', '🌙💫');
    expect(a).not.toBe(b);
  });

  it('distinguishes the same text from different authors', () => {
    expect(buildCommentId('Олег', 'класс')).not.toBe(buildCommentId('Анна', 'класс'));
  });

  it('uses a separator so (author,text) pairs cannot collide by concatenation', () => {
    expect(buildCommentId('a b', 'c')).not.toBe(buildCommentId('a', 'b c'));
  });

  it('prefers a platform-native comment id when provided', () => {
    const id = buildCommentId('Олег', 'текст', '1788231991234567');
    expect(id).toBe('n:1788231991234567');
    // native id wins regardless of author/text
    expect(buildCommentId('X', 'Y', '1788231991234567')).toBe(id);
  });

  it('ignores blank native ids and falls back to the hash', () => {
    const hashed = buildCommentId('Олег', 'текст');
    expect(buildCommentId('Олег', 'текст', '   ')).toBe(hashed);
    expect(buildCommentId('Олег', 'текст', null)).toBe(hashed);
  });

  it('does not collapse to empty/author-only for non-Latin input (old-bug regression)', () => {
    const id = buildCommentId('Олег', 'только кириллица и эмодзи 🌟');
    // Stable hashed form, not an empty or stripped string.
    expect(id).toMatch(/^h:[a-f0-9]{32}$/);
  });
});
