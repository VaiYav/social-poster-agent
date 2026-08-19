/**
 * Q4: Slop lexicon unit tests — multilingual AI-tell detection.
 * Source: src/modules/content-enhancements/slop-lexicon.ts
 */
import { describe, it, expect } from 'vitest';
import { scanSlop, getSlopListForPrompt, getLexicon, SLOP_LEXICON } from '../../../src/modules/content-enhancements/slop-lexicon.js';

describe('Slop Lexicon', () => {
  it('SL-001: detects English slop words with word boundaries', () => {
    const matches = scanSlop("Let's delve into the realm of productivity.", 'en');
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

  it('SL-007: unknown language falls back to English lexicon', () => {
    expect(getLexicon('de')).toBe(SLOP_LEXICON.en);
    const matches = scanSlop('We must delve deeper.', 'de');
    expect(matches.map((m) => m.term)).toContain('delve');
  });

  it('SL-008: getSlopListForPrompt renders non-empty list per language', () => {
    for (const lang of ['en', 'es', 'it']) {
      const list = getSlopListForPrompt(lang);
      expect(list.length).toBeGreaterThan(20);
      expect(list).toContain(',');
    }
  });

  it('SL-009: clean human text produces zero matches', () => {
    const matches = scanSlop(
      'A product cycle takes 29.5 years. I checked my plan at 2am and texted my ex. Bad idea.',
      'en',
    );
    expect(matches).toHaveLength(0);
  });
});
