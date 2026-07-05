/**
 * Q4: Slop lexicon unit tests — multilingual AI-tell detection.
 * Source: src/modules/content-enhancements/slop-lexicon.ts
 */
import { describe, it, expect } from 'vitest';
import { scanSlop, getSlopListForPrompt, getLexicon, SLOP_LEXICON } from '../../../src/modules/content-enhancements/slop-lexicon';

describe('Slop Lexicon', () => {
  it('SL-001: detects English slop words with word boundaries', () => {
    const matches = scanSlop("Let's delve into the realm of astrology.", 'en');
    const terms = matches.map((m) => m.term);
    expect(terms).toContain('delve');
    expect(terms).toContain('realm');
  });

  it('SL-002: does NOT match slop words inside other words', () => {
    // "seamlessly" is banned, but "seam" is not a banned word; "journeyman"
    // contains "journey" but must not match (word boundary).
    const matches = scanSlop('The journeyman walked in.', 'en');
    expect(matches.map((m) => m.term)).not.toContain('journey');
  });

  it('SL-003: detects English slop phrases case-insensitively', () => {
    const matches = scanSlop("In Today's Fast-Paced World, stars matter.", 'en');
    expect(matches.map((m) => m.term)).toContain("in today's fast-paced world");
  });

  it('SL-004: detects Russian slop (Cyrillic word boundaries work)', () => {
    const matches = scanSlop('В современном мире каждый из нас ищет ответы.', 'ru');
    const terms = matches.map((m) => m.term);
    expect(terms).toContain('в современном мире');
    expect(terms).toContain('каждый из нас');
  });

  it('SL-005: Russian word matching does not fire on substrings', () => {
    // "уникальный" banned; "коммуникальный" is not a word but tests the boundary
    const matches = scanSlop('перекоммуникальный тест', 'ru');
    expect(matches.map((m) => m.term)).not.toContain('уникальный');
  });

  it('SL-006: detects Ukrainian slop', () => {
    const matches = scanSlop('У сучасному світі варто зазначити важливе.', 'uk');
    const terms = matches.map((m) => m.term);
    expect(terms).toContain('у сучасному світі');
    expect(terms).toContain('варто зазначити');
  });

  it('SL-007: unknown language falls back to English lexicon', () => {
    expect(getLexicon('de')).toBe(SLOP_LEXICON.en);
    const matches = scanSlop('We must delve deeper.', 'de');
    expect(matches.map((m) => m.term)).toContain('delve');
  });

  it('SL-008: getSlopListForPrompt renders non-empty list per language', () => {
    for (const lang of ['en', 'ru', 'uk', 'es', 'it']) {
      const list = getSlopListForPrompt(lang);
      expect(list.length).toBeGreaterThan(20);
      expect(list).toContain(',');
    }
  });

  it('SL-009: clean human text produces zero matches', () => {
    const matches = scanSlop(
      'Saturn takes 29.5 years. I checked my chart at 2am and texted my ex. Bad idea.',
      'en',
    );
    expect(matches).toHaveLength(0);
  });
});
